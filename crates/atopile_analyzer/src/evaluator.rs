use std::{
    collections::{HashMap, HashSet},
    ops::Deref,
    path::{Path, PathBuf},
};

use atopile_parser::{
    parser::{Stmt, Symbol},
    AtopileSource, Spanned,
};
use thiserror::Error;

use crate::{
    diagnostics::{AnalyzerDiagnostic, AnalyzerReporter},
    FileCache, IntoLocation, Location,
};

/// Each module is: a set of signals/pins, a set of instantiations, a set of
/// connections, and attributes. Each instantiation is an instance of a module
/// and can have its attributes overwritten by any instantiator. We can store a
/// top-level set of instantiations indexed by a "ref" which is a path:
/// path/to/file.ato:ModuleName.path.to.instance
pub(crate) struct Evaluator {
    instances: HashMap<InstanceRef, Instance>,
    connections: Vec<Connection>,
    reporter: AnalyzerReporter,
    file_cache: FileCache,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct ModuleRef {
    /// The canonicalized path to the source file that declares the root module.
    source_path: PathBuf,

    /// The name of the root module.
    module_name: Symbol,
}

impl ModuleRef {
    fn new(source_path: PathBuf, module_name: Symbol) -> Self {
        Self {
            source_path,
            module_name,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct InstanceRef {
    /// The root module that this instance belongs to.
    module: ModuleRef,
    /// A path to this instance from the root module; if empty, this is the root module itself.
    instance_path: Vec<Symbol>,
}

impl InstanceRef {
    fn new(module: ModuleRef, instance_path: Vec<Symbol>) -> Self {
        Self {
            module,
            instance_path,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Instance {
    module: ModuleRef,
    signals: HashSet<Symbol>,
    attributes: HashMap<Symbol, String>,
}

impl Instance {
    fn new(module: ModuleRef) -> Self {
        Self {
            module,
            signals: HashSet::new(),
            attributes: HashMap::new(),
        }
    }

    fn add_signal(&mut self, signal: Symbol) {
        self.signals.insert(signal);
    }

    fn add_attribute(&mut self, attribute: Symbol, value: String) {
        self.attributes.insert(attribute, value);
    }
}

pub(crate) struct Connection {
    left: Symbol,
    right: Symbol,
}

#[derive(Debug, Clone, Error)]
#[error("{kind}{}", .message.as_ref().map(|m| format!(": {}", m)).unwrap_or_default())]
pub struct EvaluatorError {
    pub kind: EvaluatorErrorKind,
    pub location: Location,
    pub message: Option<String>,
}

impl EvaluatorError {
    fn new(kind: EvaluatorErrorKind, location: &Location) -> Self {
        Self {
            kind,
            location: location.clone(),
            message: None,
        }
    }

    fn with_message(mut self, message: String) -> Self {
        self.message = Some(message);
        self
    }
}

#[derive(Debug, Clone, Error)]
pub enum EvaluatorErrorKind {
    #[error("Import path not found")]
    ImportPathNotFound,
    #[error("Cyclic import detected")]
    ImportCycle,
    #[error("Failed to load import")]
    ImportLoadFailed,
    #[error("Symbol not found")]
    ImportNotFound,
}

type EvaluatorResult<T> = Result<T, EvaluatorError>;

trait ResultExt<T, E, U> {
    fn with_context(
        self,
        source: &AtopileSource,
        kind: impl FnOnce(E) -> EvaluatorErrorKind,
        spanned: &Spanned<U>,
    ) -> EvaluatorResult<T>;
}

impl<T, E: std::fmt::Display, U> ResultExt<T, E, U> for Result<T, E> {
    fn with_context(
        self,
        source: &AtopileSource,
        kind: impl FnOnce(E) -> EvaluatorErrorKind,
        spanned: &Spanned<U>,
    ) -> EvaluatorResult<T> {
        self.map_err(|e| {
            let message = e.to_string();
            EvaluatorError {
                kind: kind(e),
                location: spanned.span().into_location(source),
                message: Some(message),
            }
        })
    }
}

struct FileScope {
    symbols: HashMap<Symbol, ModuleRef>,
}

impl FileScope {
    fn new() -> Self {
        Self {
            symbols: HashMap::new(),
        }
    }

    fn define(&mut self, symbol: Symbol, module_ref: &ModuleRef) {
        self.symbols.insert(symbol, module_ref.clone());
    }

    fn resolve(&self, symbol: Symbol) -> Option<&ModuleRef> {
        self.symbols.get(&symbol)
    }
}

impl<T, U> ResultExt<T, (), U> for Option<T> {
    fn with_context(
        self,
        source: &AtopileSource,
        kind: impl FnOnce(()) -> EvaluatorErrorKind,
        spanned: &Spanned<U>,
    ) -> EvaluatorResult<T> {
        self.ok_or_else(|| EvaluatorError::new(kind(()), &spanned.span().into_location(source)))
    }
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
///
/// The returned path is always canonicalized.
pub(crate) fn resolve_import_path(ctx_path: &Path, import_path: &Path) -> Option<PathBuf> {
    if import_path.is_absolute() {
        return Some(import_path.to_path_buf());
    }

    // 1. Check relative to the folder of ctx_path
    if let Some(parent) = ctx_path.parent() {
        let relative_path = parent.join(import_path);
        if let Ok(path) = relative_path.canonicalize() {
            return Some(path);
        }
    }

    // 2. If we're in a .ato folder, use its parent as project root
    let mut current_dir = ctx_path.parent();
    while let Some(dir) = current_dir {
        if dir.file_name().map_or(false, |name| name == ".ato") {
            if let Some(project_root) = dir.parent() {
                // Check relative to project root
                let project_relative = project_root.join(import_path);
                if let Ok(path) = project_relative.canonicalize() {
                    return Some(path);
                }

                // Check in .ato/modules
                let modules_path = project_root.join(".ato").join("modules").join(import_path);
                if let Ok(path) = modules_path.canonicalize() {
                    return Some(path);
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
            if let Ok(path) = project_relative.canonicalize() {
                return Some(path);
            }

            // Check in .ato/modules
            let modules_path = dir.join(".ato").join("modules").join(import_path);
            if let Ok(path) = modules_path.canonicalize() {
                return Some(path);
            }

            // If we found the project root but couldn't find the import,
            // break to avoid walking up further
            break;
        }
        current_dir = dir.parent();
    }

    None
}

impl Evaluator {
    pub(crate) fn new() -> Self {
        Self {
            instances: HashMap::new(),
            connections: Vec::new(),
            reporter: AnalyzerReporter::new(),
            file_cache: FileCache::new(),
        }
    }

    pub(crate) fn reporter(&self) -> &AnalyzerReporter {
        &self.reporter
    }

    fn resolve_instance(&self, instance_ref: &InstanceRef) -> Option<&Instance> {
        self.instances.get(instance_ref)
    }

    fn add_instance(&mut self, instance_ref: InstanceRef, instance: Instance) {
        self.instances.insert(instance_ref, instance);
    }

    fn evaluate_import(
        &mut self,
        source: &AtopileSource,
        import_stack: &Vec<PathBuf>,
        file_scope: &mut FileScope,
        import_path: &Spanned<String>,
        import_symbols: &Vec<Spanned<Symbol>>,
    ) -> EvaluatorResult<()> {
        let path = resolve_import_path(source.path(), Path::new(import_path.deref()))
            .with_context(
                source,
                |_| EvaluatorErrorKind::ImportPathNotFound,
                &import_path,
            )?;

        if import_stack.iter().any(|p| p == &path) {
            return Err(EvaluatorError::new(
                EvaluatorErrorKind::ImportCycle,
                &import_path.span().into_location(source),
            ));
        }

        let imported_source = self.file_cache.get_or_load(&path).with_context(
            source,
            |_| EvaluatorErrorKind::ImportLoadFailed,
            &import_path,
        )?;

        let mut import_stack = import_stack.clone();
        import_stack.push(path.clone());

        self.evaluate_inner(&imported_source, import_stack);

        for imported_symbol in import_symbols {
            let instance_ref = InstanceRef::new(
                ModuleRef::new(path.clone(), imported_symbol.deref().clone()),
                vec![],
            );

            if let Some(instance) = self.resolve_instance(&instance_ref) {
                file_scope.define(imported_symbol.deref().clone(), &instance.module);
            } else {
                self.reporter.report(
                    EvaluatorError::new(
                        EvaluatorErrorKind::ImportNotFound,
                        &imported_symbol.span().into_location(source),
                    )
                    .into(),
                );
            }
        }

        Ok(())
    }

    fn evaluate_stmt(
        &mut self,
        source: &AtopileSource,
        import_stack: &Vec<PathBuf>,
        file_scope: &mut FileScope,
        stmt: &Stmt,
    ) -> EvaluatorResult<()> {
        match stmt {
            Stmt::Import(import) => self.evaluate_import(
                source,
                import_stack,
                file_scope,
                &import.from_path,
                &import.imports,
            ),
            Stmt::DepImport(dep_import) => self.evaluate_import(
                source,
                import_stack,
                file_scope,
                &dep_import.from_path,
                &vec![dep_import.name.clone()],
            ),
            Stmt::Block(block) => {
                let module_ref =
                    ModuleRef::new(source.path().to_path_buf(), block.name.deref().clone());
                let instance = Instance::new(module_ref.clone());
                let instance_ref = InstanceRef::new(module_ref, vec![]);
                self.add_instance(instance_ref, instance);

                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn evaluate_ast(
        &mut self,
        source: &AtopileSource,
        file_scope: &mut FileScope,
        import_stack: Vec<PathBuf>,
    ) -> Vec<EvaluatorError> {
        source
            .ast()
            .iter()
            .filter_map(|stmt| {
                self.evaluate_stmt(source, &import_stack, file_scope, stmt)
                    .err()
            })
            .collect()
    }

    fn evaluate_inner(&mut self, source: &AtopileSource, import_stack: Vec<PathBuf>) {
        self.reporter.clear(source.path());

        let mut file_scope = FileScope::new();
        let errs = self.evaluate_ast(source, &mut file_scope, import_stack);

        for err in errs {
            self.reporter.report(err.into());
        }
    }

    pub(crate) fn evaluate(&mut self, source: &AtopileSource) {
        log::debug!("evaluating source: {:?}", source.path());
        self.evaluate_inner(source, vec![]);
    }
}
