pub mod diagnostics;
mod module;
mod unused_interface;

use std::{cell::RefCell, collections::HashMap, fmt::Debug, ops::Deref, path::PathBuf, sync::Arc};

use anyhow::{Context, Result};
use atopile_parser::{parser::*, AtopileSource, Position, Span, Spanned};
use log::{info, warn};
use module::{Connection, Instantiation, Interface, Module, ModuleKind};
use serde::Serialize;

use diagnostics::*;

#[derive(Debug, Clone, Serialize)]
pub struct Location {
    // TODO: Windows and Unix paths don't play nice together in snapshot tests, so just skip
    // serialization for now.
    #[serde(skip)]
    pub file: PathBuf,
    pub range: Range,
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

impl<T> Located<T> {
    pub fn new(item: T, location: Location) -> Self {
        Self(item, location)
    }

    pub fn from_spanned(spanned: Spanned<T>, source: &AtopileSource, path: &PathBuf) -> Self {
        let location = Location {
            file: path.clone(),
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

/// A result from a goto definition request.
#[derive(Debug)]
pub struct GotoDefinitionResult {
    pub file: PathBuf,
    pub source_range: Range,
    pub target_range: Range,
    pub target_selection_range: Range,
}

/// A wrapper around an `AtopileSource` that adds some convenience methods for analysis.
#[derive(Debug, Clone)]
pub(crate) struct AnalyzerSource {
    pub(crate) file: AtopileSource,
    pub(crate) modules: HashMap<String, Arc<Module>>,
}

impl AnalyzerSource {
    pub fn new(source: AtopileSource, modules: HashMap<String, Arc<Module>>) -> Self {
        Self {
            file: source,
            modules,
        }
    }

    fn port_ref_at_in_expr<'a>(
        &'a self,
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
    pub fn port_ref_at(&self, index: usize) -> Option<&Spanned<PortRef>> {
        let stmt = self.file.stmt_at(index)?;
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
                        Some(&port)
                    } else {
                        None
                    }
                } else if let Connectable::Port(port) = &connect.right.deref() {
                    if port.span().contains(&index) {
                        Some(&port)
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

    fn symbol_name_at_in_expr<'a>(
        &'a self,
        index: usize,
        expr: &'a Spanned<Expr>,
    ) -> Option<&'a Spanned<String>> {
        match &expr.deref() {
            Expr::New(symbol) => symbol.span().contains(&index).then(|| symbol),
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
    pub fn symbol_name_at(&self, index: usize) -> Option<&Spanned<String>> {
        let stmt = self.file.stmt_at(index)?;
        match &stmt.deref() {
            Stmt::Import(import) => import.imports.iter().find(|i| i.span().contains(&index)),
            Stmt::DepImport(import) => import.name.span().contains(&index).then(|| &import.name),
            Stmt::Assign(assign) => self.symbol_name_at_in_expr(index, &assign.value),
            Stmt::Specialize(specialize) => specialize
                .value
                .span()
                .contains(&index)
                .then(|| &specialize.value),
            Stmt::Block(block) => block
                .parent
                .as_ref()
                .and_then(|p| p.span().contains(&index).then(|| p)),
            _ => None,
        }
    }

    pub fn file_path_at(&self, index: usize) -> Option<&Spanned<String>> {
        let stmt = self.file.stmt_at(index)?;
        match &stmt.deref() {
            Stmt::Import(import) => import
                .from_path
                .span()
                .contains(&index)
                .then(|| &import.from_path),
            Stmt::DepImport(import) => import
                .from_path
                .span()
                .contains(&index)
                .then(|| &import.from_path),
            _ => None,
        }
    }
}

pub struct AtopileAnalyzer {
    files: FileCache,
}

struct FileCache {
    files: RefCell<HashMap<PathBuf, AnalyzerSource>>,
}

impl FileCache {
    pub fn new() -> Self {
        Self {
            files: RefCell::new(HashMap::new()),
        }
    }

    pub fn get(&self, path: &PathBuf) -> Option<AnalyzerSource> {
        self.files.borrow().get(path).cloned()
    }

    pub fn insert(&self, path: PathBuf, source: AnalyzerSource) {
        self.files.borrow_mut().insert(path, source);
    }

    pub fn remove(&self, path: &PathBuf) {
        self.files.borrow_mut().remove(path);
    }
}

impl AtopileAnalyzer {
    pub fn new() -> Self {
        Self {
            files: FileCache::new(),
        }
    }

    fn analyze_source(&self, source: AtopileSource) -> Result<AnalyzerSource> {
        let modules = source
            .traverse_all_stmts()
            .filter_map(|(stmt, _)| match stmt.deref() {
                Stmt::Block(block) => Some(block),
                _ => None,
            })
            .filter(|block| matches!(block.kind.deref(), BlockKind::Module | BlockKind::Component))
            .map(|block| {
                self.analyze_module(&source, block)
                    .map(|module| (block.name.deref().clone(), Arc::new(module)))
            })
            .collect::<Result<HashMap<_, _>>>()
            .context("Error analyzing modules")?;

        Ok(AnalyzerSource::new(source, modules))
    }

    /// Load the source file at the given path without analyzing it.
    fn load_raw_source(path: &PathBuf) -> Result<AtopileSource> {
        let content = std::fs::read_to_string(path).context("Failed to read source file")?;
        AtopileSource::new(content, path.clone())
            .map_err(|e| anyhow::anyhow!("Failed to load source: {:?}", e))
    }

    /// Load the source file at the given path. Will first check the in-memory cache maintained by
    /// `set_source`, and if not found, read from the filesystem.
    fn load_source(&self, path: &PathBuf) -> Result<AnalyzerSource> {
        info!("loading source: {:?}", path);
        let path = path.canonicalize()?;

        if let Some(source) = self.files.get(&path) {
            info!("source already loaded: {:?}", path);
            return Ok(source);
        }

        info!("loading source from disk: {:?}", path);
        let source = Self::load_raw_source(&path)
            .map_err(|e| anyhow::anyhow!("Failed to load source: {:?}", e))?;
        let analyzer_source = self.analyze_source(source)?;
        self.files.insert(path, analyzer_source.clone());
        Ok(analyzer_source)
    }

    /// Set the source file at the given path.
    pub fn set_source(&mut self, path: &PathBuf, source: AtopileSource) -> Result<()> {
        let path = path.canonicalize()?;
        let analyzer_source = self.analyze_source(source)?;
        self.files.insert(path, analyzer_source);
        Ok(())
    }

    /// Remove the source file at the given path.
    pub fn remove_source(&mut self, path: &PathBuf) -> Result<()> {
        self.files.remove(&path.canonicalize()?);
        Ok(())
    }

    /// Run all diagnostics on the given source file.
    pub fn diagnostics(&self, path: &PathBuf) -> Result<Vec<AnalyzerDiagnostic>> {
        let mut diagnostics = vec![];

        diagnostics.extend(self.analyze_unused_interfaces(path)?);

        Ok(diagnostics)
    }

    /// Resolve an import `import_path` relative to current path `ctx_path`. We check these paths
    /// in order of precedence:
    /// 1. Relative to the folder of `ctx_path`
    /// 2. Relative to the project root (marked by ato.yaml)
    /// 3. Relative to .ato/modules in the project root.
    ///
    /// The "project root" is determined by these rules:
    ///  - If the `ctx_path` is in a `.ato` directory, the parent of the `.ato` directory is the
    ///    project root.
    ///  - Otherwise, walk up the tree until a directory containing `ato.yaml` is found.
    fn resolve_import_path(&self, ctx_path: &PathBuf, import_path: &PathBuf) -> Result<PathBuf> {
        if import_path.is_absolute() {
            return Ok(import_path.to_path_buf());
        }

        // 1. Check relative to the folder of ctx_path
        if let Some(parent) = ctx_path.parent() {
            let relative_path = parent.join(import_path);
            if relative_path.exists() {
                return Ok(relative_path);
            }
        }

        // 2. If we're in a .ato folder, use its parent as project root
        let mut current_dir = ctx_path.parent();
        while let Some(dir) = current_dir {
            if dir.file_name().map_or(false, |name| name == ".ato") {
                if let Some(project_root) = dir.parent() {
                    // Check relative to project root
                    let project_relative = project_root.join(import_path);
                    if project_relative.exists() {
                        return Ok(project_relative);
                    }

                    // Check in .ato/modules
                    let modules_path = project_root.join(".ato").join("modules").join(import_path);
                    if modules_path.exists() {
                        return Ok(modules_path);
                    }
                }
                break;
            }
            current_dir = dir.parent();
        }

        // 3. Walk up the tree to find project root (marked by ato.yaml)
        let mut current_dir = ctx_path.parent();
        while let Some(dir) = current_dir {
            if dir.join("ato.yaml").exists() {
                // Found project root, check if import exists relative to it
                let project_relative = dir.join(import_path);
                if project_relative.exists() {
                    return Ok(project_relative);
                }

                // Check in .ato/modules
                let modules_path = dir.join(".ato").join("modules").join(import_path);
                if modules_path.exists() {
                    return Ok(modules_path);
                }

                // If we found the project root but couldn't find the import,
                // break to avoid walking up further
                break;
            }
            current_dir = dir.parent();
        }

        // If we get here, we couldn't find the import
        anyhow::bail!("Could not resolve import path: {:?}", import_path)
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
                &source,
                source.path(),
            )))
        } else {
            // Let's see if we import this symbol, then recurse.
            info!("looking for import for {:?}", name);
            let imported_file = source
                .traverse_all_stmts()
                .filter_map(|(stmt, _)| match stmt.deref() {
                    Stmt::Import(import) => Some((
                        import.from_path.deref().into(),
                        import.imports.iter().map(|i| i.deref().clone()).collect(),
                    )),
                    Stmt::DepImport(import) => Some((
                        import.from_path.deref().into(),
                        vec![import.name.deref().clone()],
                    )),
                    _ => None,
                })
                .find(|(_import_path, imports)| imports.iter().any(|i| i.deref() == name))
                .map(|(import_path, _imports)| {
                    let path = self.resolve_import_path(source.path(), &import_path);
                    info!("resolved import path: {:?}", path);
                    path
                })
                .transpose()
                .context(format!("failed to resolve import path for {:?}", name))?
                .map(|import| self.load_source(&import))
                .transpose()
                .context(format!("failed to load source for import {:?}", name))?;

            if let Some(imported_file) = imported_file {
                info!("found imported file: {:?}", imported_file.file.path());
                self.find_definition(&imported_file.file.clone(), name)
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
            .find(|b: &Spanned<&BlockStmt>| b.deref().name.deref() == name)
    }

    /// Create a GotoDefinitionResult for the path component of an import, e.g. `path/to/file.ato`
    /// here:
    /// ```ato
    /// from "path/to/file.ato" import Symbol
    /// ```
    fn handle_goto_definition_path(
        &self,
        source: &AtopileSource,
        source_path: &PathBuf,
        path_token: &Spanned<String>,
    ) -> Result<Option<GotoDefinitionResult>> {
        let source_range_start = source.index_to_position(path_token.span().start);
        let source_range_end = source.index_to_position(path_token.span().end);

        let resolved_path = self.resolve_import_path(source_path, &path_token.deref().into())?;

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

    /// Create a GotoDefinitionResult for the import component of an import, e.g. `Symbol` here:
    /// ```ato
    /// from "path/to/file.ato" import Symbol
    /// ```
    fn handle_goto_definition_import(
        &self,
        source: &AtopileSource,
        source_path: &PathBuf,
        import_path: &PathBuf,
        import: &Spanned<String>,
    ) -> Result<Option<GotoDefinitionResult>> {
        let source_range_start = source.index_to_position(import.span().start);
        let source_range_end = source.index_to_position(import.span().end);

        let resolved_path = self.resolve_import_path(source_path, &import_path.deref().into())?;

        let target = self.load_source(&resolved_path)?;
        let target_block = self.find_definition_in_source(&target.file, import.as_str());

        let result = target_block.map(|block| {
            let target_selection_range_start =
                target.file.index_to_position(block.name.span().start);
            let target_selection_range_end = target.file.index_to_position(block.name.span().end);

            let target_range_start = block.span().start;
            let target_range_end = block.span().end;

            GotoDefinitionResult {
                file: resolved_path,
                source_range: Range {
                    start: source_range_start,
                    end: source_range_end,
                },
                target_range: Range {
                    start: target.file.index_to_position(target_range_start),
                    end: target.file.index_to_position(target_range_end),
                },
                target_selection_range: Range {
                    start: target_selection_range_start,
                    end: target_selection_range_end,
                },
            }
        });

        Ok(result)
    }

    fn handle_goto_definition_for_symbol(
        &self,
        source: &AtopileSource,
        symbol: &Spanned<String>,
    ) -> Result<Option<GotoDefinitionResult>> {
        let def = self.find_definition(source, &symbol.deref())?;

        if let Some(def) = def {
            Ok(Some(GotoDefinitionResult {
                file: def.location().file.clone(),
                source_range: Range {
                    start: source.index_to_position(symbol.span().start),
                    end: source.index_to_position(symbol.span().end),
                },
                target_range: def.location().range.clone(),
                target_selection_range: def.location().range.clone(),
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
        let source = self.files.get(path).context("Source not found")?;

        let index = source.file.position_to_index(position);
        let stmt = source.file.stmt_at(index).map(|s| s.deref());
        let port_ref = source.port_ref_at(index).map(|p| p.deref());
        let symbol = source.symbol_name_at(index);
        let file_path = source.file_path_at(index);

        if let Some(symbol) = symbol {
            self.handle_goto_definition_for_symbol(&source.file, symbol)
        } else if let Some(file_path) = file_path {
            self.handle_goto_definition_path(&source.file, path, file_path)
        } else {
            Ok(None)
        }
    }

    /// Parse the contents of a block into its semantic representation.
    fn analyze_module(&self, source: &AtopileSource, block: &BlockStmt) -> Result<Module> {
        let parent_block = if let Some(parent) = &block.parent {
            let parent_block_def =
                self.find_definition(source, &parent.deref())
                    .context(format!(
                        "can't find definition for parent of {:?}",
                        block.name.deref()
                    ))?;
            if let Some(parent_block_def) = parent_block_def {
                let parent_block_source = Self::load_raw_source(&parent_block_def.location().file)
                    .context(format!(
                        "can't load source for parent of {:?}",
                        block.name.deref()
                    ))?;
                Some(
                    self.analyze_module(&parent_block_source, &parent_block_def)
                        .context(format!("can't analyze parent of {:?}", block.name.deref()))?,
                )
            } else {
                anyhow::bail!(
                    "Tried to analyze block {:?}: parent not found",
                    block.name.deref()
                );
            }
        } else {
            None
        };

        // Build a vector of (Span, PortRef, Located<BlockStmt>) triples for each assignment.
        let new_assignments: Vec<(Span, PortRef, Located<BlockStmt>)> = block
            .body
            .iter()
            .filter_map(|stmt| match stmt.deref() {
                // Pull out just the AssignStmts and their spans.
                Stmt::Assign(assign) => Some((assign, stmt.span().clone())),
                _ => None,
            })
            .filter_map(|(assign_stmt, span)| match assign_stmt.value.deref() {
                // Pull out just `x = new Module` assignments, split up into the
                // portref and the type name.
                Expr::New(type_name) => Some((
                    span,
                    assign_stmt.target.deref().clone(),
                    type_name.deref().to_string(),
                )),
                _ => None,
            })
            .filter_map(|(span, port, type_name)| {
                // Replace the typename with the definition of the module.
                self.find_definition(source, &type_name)
                    .ok()
                    .flatten()
                    .map(|def| (span, port, def))
            })
            .collect::<Vec<_>>();

        let mut instantiations: HashMap<String, Instantiation> = HashMap::new();
        let mut interfaces: HashMap<String, Interface> = HashMap::new();

        for (span, port, def_block) in &new_assignments {
            match def_block.kind.deref() {
                BlockKind::Module | BlockKind::Component => {
                    let ident = port.to_string();
                    let module = self.analyze_module(
                        &Self::load_raw_source(&def_block.location().file)?,
                        &def_block,
                    )?;
                    instantiations.insert(
                        ident.clone(),
                        Instantiation {
                            ident,
                            module: Arc::new(module),
                            location: Location {
                                file: source.path().clone(),
                                range: Range {
                                    start: source.index_to_position(span.start),
                                    end: source.index_to_position(span.end),
                                },
                            },
                        },
                    );
                }
                BlockKind::Interface => {
                    let ident = port.to_string();
                    let interface = def_block.name.deref().to_string();
                    interfaces.insert(
                        ident.clone(),
                        Interface {
                            ident,
                            interface,
                            location: Location {
                                file: source.path().clone(),
                                range: Range {
                                    start: source.index_to_position(span.start),
                                    end: source.index_to_position(span.end),
                                },
                            },
                        },
                    );
                }
            }
        }

        // Parse connections.
        let mut connections: Vec<Connection> = vec![];
        for stmt in &block.body {
            if let Stmt::Connect(connect) = stmt.deref() {
                connections.push(Connection {
                    left: connect.left.deref().clone(),
                    right: connect.right.deref().clone(),
                });
            }
        }

        // Merge in parent information.
        if let Some(parent) = parent_block {
            interfaces.extend(parent.interfaces.into_iter());
            instantiations.extend(parent.instantiations.into_iter());
            connections.extend(parent.connections.into_iter());
        }

        Ok(Module {
            instantiations,
            interfaces,
            connections,
            name: block.name.deref().to_string(),
            kind: match block.kind.deref() {
                BlockKind::Component => ModuleKind::Component,
                BlockKind::Module => ModuleKind::Module,
                _ => unreachable!(),
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use assert_fs::{prelude::*, TempDir};
    use insta::assert_yaml_snapshot;

    #[test]
    fn test_analyze_block() {
        let temp_dir = TempDir::new().unwrap();
        let temp_file = temp_dir.child("test.ato");
        temp_file
            .write_str(
                r#"
interface IF:
    pass

module MOD:
    if = new IF

module P:
    a = new MOD

module M from P:
    b = new MOD
    "#,
            )
            .unwrap();

        let analyzer = AtopileAnalyzer::new();
        let source = analyzer
            .load_source(&temp_file.path().to_path_buf())
            .unwrap();

        let block = analyzer
            .find_definition(&source.file, "M")
            .ok()
            .flatten()
            .expect("Module not found");
        let module = analyzer
            .analyze_module(&source.file, &block)
            .expect("Failed to analyze block");

        insta::with_settings!({
            sort_maps => true,
        }, {
            assert_yaml_snapshot!(module, @r###"
            name: M
            kind: Module
            instantiations:
              a:
                ident: a
                module:
                  name: MOD
                  kind: Module
                  instantiations: {}
                  interfaces:
                    if:
                      ident: if
                      interface: IF
                      location:
                        range:
                          start:
                            line: 5
                            column: 4
                          end:
                            line: 5
                            column: 15
                  connections: []
                location:
                  range:
                    start:
                      line: 8
                      column: 4
                    end:
                      line: 8
                      column: 15
              b:
                ident: b
                module:
                  name: MOD
                  kind: Module
                  instantiations: {}
                  interfaces:
                    if:
                      ident: if
                      interface: IF
                      location:
                        range:
                          start:
                            line: 5
                            column: 4
                          end:
                            line: 5
                            column: 15
                  connections: []
                location:
                  range:
                    start:
                      line: 11
                      column: 4
                    end:
                      line: 11
                      column: 15
            interfaces: {}
            connections: []
            "###);
        });
    }
}
