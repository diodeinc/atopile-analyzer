pub mod diagnostics;
pub mod evaluator;

use std::{
    collections::HashMap,
    fmt::{Debug, Display},
    ops::Deref,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result};
use atopile_parser::{
    parser::{BlockStmt, Connectable, Expr, PortRef, Stmt, Symbol},
    AtopileSource, Position, Span, Spanned,
};
use evaluator::{resolve_import_path, Evaluator};
use log::{debug, info, warn};
use serde::Serialize;

use diagnostics::*;

pub use crate::evaluator::EvaluatorState;

#[derive(Debug, Clone, Serialize)]
pub struct Location {
    // TODO: Windows and Unix paths don't play nice together in snapshot tests, so just skip
    // serialization for now.
    #[serde(skip)]
    pub file: PathBuf,
    pub range: Range,
}

impl Display for Location {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}", self.file.display(), self.range.start)
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

#[derive(Debug)]
pub struct Located<T>(T, Location);

impl<T> Deref for Located<T> {
    type Target = T;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

trait AsLocation {
    fn as_location(&self) -> Location;
}

impl<T> AsLocation for Located<T> {
    fn as_location(&self) -> Location {
        self.1.clone()
    }
}

impl AsLocation for Location {
    fn as_location(&self) -> Location {
        self.clone()
    }
}

impl<T> Located<T> {
    pub fn new(item: T, location: Location) -> Self {
        Self(item, location)
    }

    pub fn from_spanned(spanned: Spanned<T>, source: &AtopileSource, path: &Path) -> Self {
        let location = Location {
            file: path.to_path_buf(),
            range: Range {
                start: source.index_to_position(spanned.span().start),
                end: source.index_to_position(spanned.span().end),
            },
        };

        Self::new(spanned.take(), location)
    }

    pub fn location(&self) -> &Location {
        &self.1
    }
}

impl<T> From<(T, Location)> for Located<T> {
    fn from((item, location): (T, Location)) -> Self {
        Self(item, location)
    }
}

impl<T: ToOwned> Located<&T> {
    pub fn to_owned(&self) -> Located<T::Owned> {
        Located(self.0.to_owned(), self.1.clone())
    }
}

trait IntoLocated<T> {
    fn into_located(self, source: &AtopileSource) -> Located<T>;
}

impl<T> IntoLocated<T> for Spanned<T> {
    fn into_located(self, source: &AtopileSource) -> Located<T> {
        Located::from_spanned(self, source, source.path())
    }
}

trait IntoLocation {
    fn to_location(&self, source: &AtopileSource) -> Location;
}

impl IntoLocation for Span {
    fn to_location(&self, source: &AtopileSource) -> Location {
        Location {
            file: source.path().to_path_buf(),
            range: Range {
                start: source.index_to_position(self.start),
                end: source.index_to_position(self.end),
            },
        }
    }
}

/// A result from a goto definition request.
#[derive(Debug)]
pub struct GotoDefinitionResult {
    pub file: PathBuf,
    pub source_range: Range,
    pub target_range: Range,
    pub target_selection_range: Range,
}

trait AtopileSourceExt {
    #[allow(clippy::only_used_in_recursion)]
    fn port_ref_at_in_expr<'a>(
        &self,
        index: usize,
        expr: &'a Spanned<Expr>,
    ) -> Option<&'a Spanned<PortRef>>;

    /// Returns a PortRef that is at the given index into the source file, if there is one.
    #[allow(dead_code)]
    fn port_ref_at(&self, index: usize) -> Option<&Spanned<PortRef>>;

    #[allow(clippy::only_used_in_recursion)]
    fn symbol_name_at_in_expr<'a>(
        &self,
        index: usize,
        expr: &'a Spanned<Expr>,
    ) -> Option<&'a Spanned<Symbol>>;

    /// Returns a Spanned<String> for a symbol name that is at the given index
    /// into the source file, if there is one.
    fn symbol_name_at(&self, index: usize) -> Option<&Spanned<Symbol>>;

    fn file_path_at(&self, index: usize) -> Option<&Spanned<String>>;
}

impl AtopileSourceExt for AtopileSource {
    #[allow(clippy::only_used_in_recursion)]
    fn port_ref_at_in_expr<'a>(
        &self,
        index: usize,
        expr: &'a Spanned<Expr>,
    ) -> Option<&'a Spanned<PortRef>> {
        match &expr.deref() {
            Expr::Port(port) => {
                if port.span().contains(&index) {
                    Some(port)
                } else {
                    None
                }
            }
            Expr::BinaryOp(binary_op) => {
                if binary_op.left.span().contains(&index) {
                    self.port_ref_at_in_expr(index, &binary_op.left)
                } else if binary_op.right.span().contains(&index) {
                    self.port_ref_at_in_expr(index, &binary_op.right)
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    /// Returns a PortRef that is at the given index into the source file, if there is one.
    fn port_ref_at(&self, index: usize) -> Option<&Spanned<PortRef>> {
        let stmt = self.stmt_at(index)?;
        match &stmt.deref() {
            Stmt::Assign(assign) => {
                if assign.target.span().contains(&index) {
                    Some(&assign.target)
                } else {
                    self.port_ref_at_in_expr(index, &assign.value)
                }
            }
            Stmt::Specialize(specialize) => {
                if specialize.port.span().contains(&index) {
                    Some(&specialize.port)
                } else {
                    None
                }
            }
            Stmt::Connect(connect) => {
                if let Connectable::Port(port) = &connect.left.deref() {
                    if port.span().contains(&index) {
                        Some(port)
                    } else {
                        None
                    }
                } else if let Connectable::Port(port) = &connect.right.deref() {
                    if port.span().contains(&index) {
                        Some(port)
                    } else {
                        None
                    }
                } else {
                    None
                }
            }
            Stmt::Assert(assert) => self.port_ref_at_in_expr(index, &assert.expr),
            _ => None,
        }
    }

    #[allow(clippy::only_used_in_recursion)]
    fn symbol_name_at_in_expr<'a>(
        &self,
        index: usize,
        expr: &'a Spanned<Expr>,
    ) -> Option<&'a Spanned<Symbol>> {
        match &expr.deref() {
            Expr::New(symbol) => symbol.span().contains(&index).then_some(symbol),
            Expr::BinaryOp(binary_op) => {
                if binary_op.left.span().contains(&index) {
                    self.symbol_name_at_in_expr(index, &binary_op.left)
                } else if binary_op.right.span().contains(&index) {
                    self.symbol_name_at_in_expr(index, &binary_op.right)
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    /// Returns a Spanned<String> for a symbol name that is at the given index
    /// into the source file, if there is one.
    fn symbol_name_at(&self, index: usize) -> Option<&Spanned<Symbol>> {
        let stmt = self.stmt_at(index)?;
        match &stmt.deref() {
            Stmt::Import(import) => import.imports.iter().find(|i| i.span().contains(&index)),
            Stmt::DepImport(import) => import.name.span().contains(&index).then_some(&import.name),
            Stmt::Assign(assign) => self.symbol_name_at_in_expr(index, &assign.value),
            Stmt::Specialize(specialize) => specialize
                .value
                .span()
                .contains(&index)
                .then_some(&specialize.value),
            Stmt::Block(block) => block
                .parent
                .as_ref()
                .and_then(|p| p.span().contains(&index).then_some(p)),
            _ => None,
        }
    }

    fn file_path_at(&self, index: usize) -> Option<&Spanned<String>> {
        let stmt = self.stmt_at(index)?;
        match &stmt.deref() {
            Stmt::Import(import) => import
                .from_path
                .span()
                .contains(&index)
                .then_some(&import.from_path),
            Stmt::DepImport(import) => import
                .from_path
                .span()
                .contains(&index)
                .then_some(&import.from_path),
            _ => None,
        }
    }
}
pub(crate) struct FileCache {
    files: Mutex<HashMap<PathBuf, FileCacheEntry>>,
}

#[derive(Clone)]
struct FileCacheEntry {
    source: Arc<AtopileSource>,
}

impl FileCacheEntry {
    pub fn new(source: Arc<AtopileSource>) -> Self {
        Self { source }
    }
}

impl FileCache {
    pub fn new() -> Self {
        Self {
            files: Mutex::new(HashMap::new()),
        }
    }

    pub fn get(&self, path: &Path) -> Option<Arc<AtopileSource>> {
        self.files
            .lock()
            .unwrap()
            .get(path)
            .map(|e| e.source.clone())
    }

    pub fn insert(&self, path: PathBuf, source: Arc<AtopileSource>) {
        self.files
            .lock()
            .unwrap()
            .insert(path, FileCacheEntry::new(source));
    }

    pub fn remove(&self, path: &Path) {
        self.files.lock().unwrap().remove(path);
    }
}

pub struct AtopileAnalyzer {
    files: Arc<FileCache>,
    evaluator: Evaluator,
    open_files: std::collections::HashSet<PathBuf>,
}

impl AtopileAnalyzer {
    pub fn new() -> Self {
        let files = Arc::new(FileCache::new());
        Self {
            files: files.clone(),
            evaluator: Evaluator::default(),
            open_files: std::collections::HashSet::new(),
        }
    }
}

impl Default for AtopileAnalyzer {
    fn default() -> Self {
        Self::new()
    }
}

impl AtopileAnalyzer {
    #[cfg(test)]
    pub fn evaluate_source_for_test(&self, source: &AtopileSource) -> EvaluatorState {
        let mut evaluator = Evaluator::default();
        evaluator.set_source(source.path(), Arc::new(source.clone()));
        evaluator.state().clone()
    }

    /// Load the source file at the given path. Will first check the in-memory cache maintained by
    /// `set_source`, and if not found, read from the filesystem.
    fn load_source(&self, path: &PathBuf) -> Result<Arc<AtopileSource>> {
        debug!("loading source: {:?}", path);
        let path = path.canonicalize()?;

        if let Some(source) = self.files.get(&path) {
            debug!("source already loaded: {:?}", path);
            return Ok(source.clone());
        }

        debug!("loading source from disk: {:?}", path);
        let content = std::fs::read_to_string(&path).context("Failed to read source file")?;
        let source = AtopileSource::new(content, path.to_path_buf());
        Ok(Arc::new(source))
    }

    /// Set the source file at the given path.
    pub fn set_source(&mut self, path: &Path, source: Arc<AtopileSource>) -> Result<()> {
        let path = path.canonicalize()?;
        self.files.insert(path.clone(), source.clone());
        self.evaluator.set_source(&path, source.clone());
        Ok(())
    }

    /// Remove the source file at the given path.
    pub fn remove_source(&mut self, path: &Path) -> Result<()> {
        self.files.remove(&path.canonicalize()?);
        self.open_files.remove(&path.canonicalize()?);
        self.evaluator.remove_source(path);
        Ok(())
    }

    /// Mark a file as open in the editor.
    pub fn mark_file_open(&mut self, path: &Path) -> Result<()> {
        self.open_files.insert(path.canonicalize()?);
        Ok(())
    }

    /// Mark a file as closed in the editor.
    pub fn mark_file_closed(&mut self, path: &Path) -> Result<()> {
        self.open_files.remove(&path.canonicalize()?);
        Ok(())
    }

    /// Get all open files.
    pub fn get_open_files(&self) -> &std::collections::HashSet<PathBuf> {
        &self.open_files
    }

    /// Run all diagnostics.
    pub fn diagnostics(&mut self) -> Result<Vec<AnalyzerDiagnostic>> {
        let mut diagnostics = vec![];

        diagnostics.extend(
            self.evaluator
                .reporter()
                .diagnostics()
                .values()
                .flat_map(|v| v.iter())
                .cloned(),
        );

        Ok(diagnostics)
    }

    /// Find the BlockStmt that defines the given name, traversing through imports as necessary.
    fn find_definition(
        &self,
        source: &AtopileSource,
        name: &str,
    ) -> Result<Option<Located<BlockStmt>>> {
        if let Some(block) = self.find_definition_in_source(source, name) {
            // The definition is in this file, so just return it.
            Ok(Some(Located::from_spanned(
                block.to_owned(),
                source,
                source.path(),
            )))
        } else {
            // Let's see if we import this symbol, then recurse.
            debug!("looking for import for {:?}", name);
            let imported_file = source
                .traverse_all_stmts()
                .filter_map(|(stmt, _)| match stmt.deref() {
                    Stmt::Import(import) => Some((
                        import.from_path.deref(),
                        import.imports.iter().map(|i| i.deref().clone()).collect(),
                    )),
                    Stmt::DepImport(import) => {
                        Some((import.from_path.deref(), vec![import.name.deref().clone()]))
                    }
                    _ => None,
                })
                .find(|(_import_path, imports)| imports.iter().any(|i| i.deref() == name))
                .map(|(import_path, _imports)| {
                    let path = resolve_import_path(source.path(), Path::new(import_path));
                    debug!("resolved import path: {:?}", path);
                    path
                })
                .context(format!("failed to resolve import path for {:?}", name))?
                .map(|import| self.load_source(&import))
                .transpose()
                .context(format!("failed to load source for import {:?}", name))?;

            if let Some(imported_file) = imported_file {
                debug!("found imported file: {:?}", imported_file.path());
                self.find_definition(&imported_file, name)
            } else {
                warn!(
                    "can't find definition for {:?}: no matching import found",
                    name
                );
                Ok(None)
            }
        }
    }

    /// Find where a block with the given name is defined in this source file.
    fn find_definition_in_source<'a>(
        &self,
        source: &'a AtopileSource,
        name: &str,
    ) -> Option<Spanned<&'a BlockStmt>> {
        source
            .ast()
            .iter()
            .filter_map(|s| match s.deref() {
                Stmt::Block(block) => Some((block, s.span().clone()).into()),
                _ => None,
            })
            .find(|b: &Spanned<&BlockStmt>| b.deref().name.deref().to_string() == name)
    }

    /// Create a GotoDefinitionResult for the path component of an import, e.g. `path/to/file.ato`
    /// here:
    /// ```ato
    /// from "path/to/file.ato" import Symbol
    /// ```
    fn handle_goto_definition_path(
        &self,
        source: &AtopileSource,
        source_path: &Path,
        path_token: &Spanned<String>,
    ) -> Result<Option<GotoDefinitionResult>> {
        let source_range_start = source.index_to_position(path_token.span().start);
        let source_range_end = source.index_to_position(path_token.span().end);

        let resolved_path = resolve_import_path(source_path, Path::new(path_token.deref()))
            .context(format!(
                "failed to resolve import path for {:?}",
                path_token
            ))?;

        Ok(Some(GotoDefinitionResult {
            file: resolved_path,
            source_range: Range {
                start: source_range_start,
                end: source_range_end,
            },
            target_range: Range {
                start: Position { line: 0, column: 0 },
                end: Position { line: 0, column: 0 },
            },
            target_selection_range: Range {
                start: Position { line: 0, column: 0 },
                end: Position { line: 0, column: 0 },
            },
        }))
    }

    fn handle_goto_definition_for_symbol(
        &self,
        source: &AtopileSource,
        symbol: &Spanned<Symbol>,
    ) -> Result<Option<GotoDefinitionResult>> {
        let def = self.find_definition(source, symbol.deref())?;

        if let Some(def) = def {
            Ok(Some(GotoDefinitionResult {
                file: def.location().file.clone(),
                source_range: Range {
                    start: source.index_to_position(symbol.span().start),
                    end: source.index_to_position(symbol.span().end),
                },
                target_range: def.location().range,
                target_selection_range: def.location().range,
            }))
        } else {
            Ok(None)
        }
    }

    /// Attempt to resolve a goto definition request at the given position.
    pub fn goto_definition(
        &self,
        path: &PathBuf,
        position: Position,
    ) -> Result<Option<GotoDefinitionResult>> {
        let source = self.load_source(path)?;

        let index = source.position_to_index(position);
        let symbol = source.symbol_name_at(index);
        let file_path = source.file_path_at(index);

        if let Some(symbol) = symbol {
            info!("goto definition for symbol: {:?}", symbol);
            self.handle_goto_definition_for_symbol(&source, symbol)
        } else if let Some(file_path) = file_path {
            info!("goto definition for path: {:?}", file_path);
            self.handle_goto_definition_path(&source, path, file_path)
        } else {
            info!("no goto definition found");
            Ok(None)
        }
    }

    pub fn get_netlist(&mut self) -> &EvaluatorState {
        self.evaluator.resolve_reference_designators();
        self.evaluator.state()
    }
}
