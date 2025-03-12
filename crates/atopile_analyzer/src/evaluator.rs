use std::{
    collections::HashMap,
    ops::Deref,
    path::{Path, PathBuf},
    time::Instant,
};

use atopile_parser::{
    parser::{BlockKind, BlockStmt, Connectable, Expr, Stmt, Symbol},
    AtopileSource, Spanned,
};
use thiserror::Error;

use crate::{diagnostics::AnalyzerReporter, AsLocation, FileCache, IntoLocation, Location};

pub(crate) struct Evaluator {
    instances: HashMap<InstanceRef, Instance>,
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
    fn new(source_path: &Path, module_name: &Symbol) -> Self {
        Self {
            source_path: source_path.to_path_buf(),
            module_name: module_name.clone(),
        }
    }

    fn port() -> Self {
        Self {
            source_path: PathBuf::new(),
            module_name: "".into(),
        }
    }
}

impl std::fmt::Display for ModuleRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}", self.source_path.display(), self.module_name)
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
    fn new(module: &ModuleRef, instance_path: Vec<Symbol>) -> Self {
        Self {
            module: module.clone(),
            instance_path,
        }
    }
}

impl From<&ModuleRef> for InstanceRef {
    fn from(module: &ModuleRef) -> Self {
        Self::new(module, vec![])
    }
}

impl From<ModuleRef> for InstanceRef {
    fn from(module: ModuleRef) -> Self {
        Self::new(&module, vec![])
    }
}

impl std::fmt::Display for InstanceRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.module)?;
        for part in &self.instance_path {
            write!(f, ".{}", part)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Copy)]
pub(crate) enum InstanceKind {
    Module,
    Component,
    Interface,
    Port,
}

#[derive(Debug, Clone)]
pub(crate) struct Instance {
    module: ModuleRef,
    kind: InstanceKind,
    attributes: HashMap<Symbol, String>,
    children: HashMap<Symbol, InstanceRef>,
    connections: Vec<Connection>,
}

impl Instance {
    fn new(module: &ModuleRef, kind: InstanceKind) -> Self {
        Self {
            module: module.clone(),
            kind,
            attributes: HashMap::new(),
            children: HashMap::new(),
            connections: Vec::new(),
        }
    }

    fn port() -> Self {
        Self {
            module: ModuleRef::port(),
            kind: InstanceKind::Port,
            attributes: HashMap::new(),
            children: HashMap::new(),
            connections: Vec::new(),
        }
    }

    fn add_attribute(&mut self, attribute: &Symbol, value: String) {
        self.attributes.insert(attribute.clone(), value);
    }

    fn add_child(&mut self, child: &Symbol, instance_ref: &InstanceRef) {
        self.children.insert(child.clone(), instance_ref.clone());
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Connection {
    left: InstanceRef,
    right: InstanceRef,
}

impl Connection {
    fn new(left: InstanceRef, right: InstanceRef) -> Self {
        Self { left, right }
    }
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

    fn internal<T: AsLocation>(location: &T, message: String) -> Self {
        Self {
            kind: EvaluatorErrorKind::Internal,
            location: location.as_location().clone(),
            message: Some(message),
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
    #[error("Unexpected statement")]
    UnexpectedStmt,
    #[error("Type not found")]
    TypeNotFound,
    #[error("Invalid assignment")]
    InvalidAssignment,
    #[error("Unparsable statement")]
    UnparsableStmt,

    #[error("Internal error")]
    Internal,
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

    fn define(&mut self, symbol: &Symbol, module_ref: &ModuleRef) {
        self.symbols.insert(symbol.clone(), module_ref.clone());
    }

    fn resolve(&self, symbol: &Symbol) -> Option<&ModuleRef> {
        self.symbols.get(symbol)
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
            reporter: AnalyzerReporter::new(),
            file_cache: FileCache::new(),
        }
    }

    pub(crate) fn reset(&mut self) {
        self.instances.clear();
    }

    pub(crate) fn reporter(&self) -> &AnalyzerReporter {
        &self.reporter
    }

    fn resolve_instance(&self, instance_ref: &InstanceRef) -> Option<&Instance> {
        self.instances.get(instance_ref)
    }

    fn resolve_instance_mut(&mut self, instance_ref: &InstanceRef) -> Option<&mut Instance> {
        self.instances.get_mut(instance_ref)
    }

    fn add_instance(&mut self, instance_ref: &InstanceRef, instance: Instance) {
        self.instances.insert(instance_ref.clone(), instance);
    }

    fn remove_instance(&mut self, instance_ref: &InstanceRef) -> Option<Instance> {
        self.instances.remove(instance_ref)
    }

    fn clone_instance(
        &mut self,
        from_ref: &InstanceRef,
        to_ref: &InstanceRef,
    ) -> anyhow::Result<()> {
        let (mut to_instance, children, connections) = {
            let from_instance = self.resolve_instance(from_ref).ok_or(anyhow::anyhow!(
                "Tried to clone instance `{}` but it doesn't exist",
                from_ref
            ))?;

            let mut to_instance = Instance::new(&to_ref.module, from_instance.kind);

            to_instance.attributes = from_instance.attributes.clone();
            (
                to_instance,
                from_instance.children.clone(),
                from_instance.connections.clone(),
            )
        };

        for (k, v) in children.iter() {
            // If:
            //  * `from_ref`       == `file.ato:ModuleA`
            //  * `k`              == `file.ato:ModuleA.a`
            //  * `to_ref`         == `file.ato:ModuleB.b`
            // Then:
            //  * `transposed_ref` == `file.ato:ModuleB.b.a`
            let mut path = to_ref.instance_path.clone();
            path.push(k.clone());
            let transposed_ref = InstanceRef::new(&to_ref.module, path);
            self.clone_instance(&v, &transposed_ref)?;
            to_instance.add_child(k, &transposed_ref);
        }

        for connection in &connections {
            let new_left = InstanceRef::new(
                &to_ref.module,
                [
                    to_ref.instance_path.clone(),
                    connection.left.instance_path.clone(),
                ]
                .concat(),
            );
            let new_right = InstanceRef::new(
                &to_ref.module,
                [
                    to_ref.instance_path.clone(),
                    connection.right.instance_path.clone(),
                ]
                .concat(),
            );

            let connection = Connection::new(new_left.clone(), new_right.clone());

            // Find the deepest common ancestor for left and right paths
            let left_path = &new_left.instance_path;
            let right_path = &new_right.instance_path;

            // Determine the common prefix length
            let common_prefix_len = left_path
                .iter()
                .zip(right_path.iter())
                .take_while(|(a, b)| a == b)
                .count();

            if common_prefix_len == 0 {
                // No common ancestor, add to the top-level instance
                to_instance
                    .connections
                    .push(Connection::new(new_left, new_right));
            } else {
                // Create a reference to the common ancestor
                let common_ancestor_path = left_path[0..common_prefix_len].to_vec();
                let common_ancestor_ref =
                    InstanceRef::new(&to_ref.module, common_ancestor_path.clone());

                // Find the common ancestor instance
                if let Some(ancestor_instance) = self.resolve_instance_mut(&common_ancestor_ref) {
                    // Add the connection to the common ancestor
                    ancestor_instance.connections.push(connection);
                } else {
                    // If we can't find the common ancestor (shouldn't happen), add to top-level
                    to_instance.connections.push(connection);
                }
            }
        }

        self.add_instance(to_ref, to_instance);

        Ok(())
    }

    fn evaluate_import(
        &mut self,
        source: &AtopileSource,
        import_stack: &Vec<PathBuf>,
        file_scope: &mut FileScope,
        import_path: &Spanned<String>,
        import_symbols: &Vec<Spanned<Symbol>>,
    ) -> EvaluatorResult<()> {
        // Fast path: check if we already evaluated this module.
        let mut load_file = false;
        for symbol in import_symbols {
            if let Some(resolved_path) =
                resolve_import_path(source.path(), Path::new(import_path.deref()))
            {
                let module_ref = ModuleRef::new(&resolved_path, symbol.deref());
                if let Some(instance) = self.resolve_instance(&module_ref.into()) {
                    file_scope.define(symbol.deref(), &instance.module);
                } else {
                    load_file = true;
                }
            } else {
                load_file = true;
            }
        }

        if !load_file {
            return Ok(());
        }

        // Resolve the import path.
        let path = resolve_import_path(source.path(), Path::new(import_path.deref()))
            .with_context(
                source,
                |_| EvaluatorErrorKind::ImportPathNotFound,
                &import_path,
            )?;

        // Check for cycles.
        if import_stack.iter().any(|p| p == &path) {
            return Err(EvaluatorError::new(
                EvaluatorErrorKind::ImportCycle,
                &import_path.span().into_location(source),
            ));
        }

        // Load and evaluate the imported module.
        let (imported_source, _) = self.file_cache.get_or_load(&path).with_context(
            source,
            |_| EvaluatorErrorKind::ImportLoadFailed,
            &import_path,
        )?;

        let mut import_stack = import_stack.clone();
        import_stack.push(path.clone());

        self.evaluate_inner(&imported_source, import_stack);

        // Define the imported symbols.
        for imported_symbol in import_symbols {
            let instance_ref = ModuleRef::new(&path, imported_symbol.deref()).into();

            if let Some(instance) = self.resolve_instance(&instance_ref) {
                file_scope.define(imported_symbol.deref(), &instance.module);
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

    fn evaluate_block_stmt(
        &mut self,
        source: &AtopileSource,
        file_scope: &FileScope,
        instance: &mut Instance,
        module_ref: &ModuleRef,
        stmt: &Spanned<Stmt>,
    ) -> EvaluatorResult<()> {
        match stmt.deref() {
            // x.y.z = ...
            Stmt::Assign(assign) => {
                let target_ref = InstanceRef::new(
                    module_ref,
                    assign
                        .target
                        .deref()
                        .parts
                        .iter()
                        .map(|p| p.deref().deref().into())
                        .collect(),
                );

                match assign.value.deref() {
                    // x = new Module
                    Expr::New(type_name) => {
                        // `x` must be a top-level name.
                        if assign.target.deref().parts.len() != 1 {
                            return Err(EvaluatorError::new(
                                EvaluatorErrorKind::InvalidAssignment,
                                &assign.target.span().into_location(source),
                            )
                            .with_message("Cannot create new module in sub-module".to_string()));
                        }

                        // Get a reference to the module that we're creating.
                        let child_name = assign.target.deref().parts.last().unwrap();
                        let type_module_ref =
                            file_scope.resolve(type_name).ok_or(EvaluatorError::new(
                                EvaluatorErrorKind::TypeNotFound,
                                &type_name.span().into_location(source),
                            ))?;

                        // Cannot create a child that already exists.
                        if let Some(_) = self.resolve_instance(&target_ref) {
                            return Err(EvaluatorError::new(
                                EvaluatorErrorKind::InvalidAssignment,
                                &assign.target.span().into_location(source),
                            )
                            .with_message(format!("`{}` already exists", child_name.deref())));
                        }

                        // Create the child instance.
                        self.clone_instance(&type_module_ref.into(), &target_ref)
                            .map_err(|e| {
                                EvaluatorError::internal(
                                    &assign.target.span().into_location(source),
                                    format!(
                                        "Failed to clone instance `{}`: {}",
                                        type_module_ref, e
                                    ),
                                )
                            })?;

                        instance.add_child(&child_name.clone().deref().deref().into(), &target_ref);
                    }
                    Expr::Port(port) => {
                        return Err(EvaluatorError::new(
                            EvaluatorErrorKind::InvalidAssignment,
                            &assign.target.span().into_location(source),
                        )
                        .with_message(format!(
                            "Cannot assign port `{}`. Maybe you meant to connect with `~`?",
                            port.deref().to_string()
                        )));
                    }
                    _ => {}
                }
                Ok(())
            }
            Stmt::Pin(pin) => {
                let pin_name = pin.name.deref();
                let pin_ref = InstanceRef::new(module_ref, vec![pin_name.clone()]);
                self.add_instance(&pin_ref, Instance::port());
                instance.add_child(pin_name, &pin_ref);
                Ok(())
            }
            Stmt::Signal(signal) => {
                let signal_name = signal.name.deref();
                let signal_ref = InstanceRef::new(module_ref, vec![signal_name.clone()]);
                self.add_instance(&signal_ref, Instance::port());
                instance.add_child(signal_name, &signal_ref);
                Ok(())
            }
            Stmt::Connect(connect) => {
                let left = connect.left.deref();
                let right = connect.right.deref();

                // Handle implicit signal/pin definitions and pull out the ConnectionHandle for each.
                let left_instance_ref = match left {
                    Connectable::Pin(signal) | Connectable::Signal(signal) => {
                        let signal_symbol: Symbol = signal.deref().clone().into();
                        let instance_ref =
                            InstanceRef::new(module_ref, vec![signal_symbol.clone()]);
                        self.add_instance(&instance_ref, Instance::port());
                        instance.add_child(&signal_symbol, &instance_ref);
                        instance_ref
                    }
                    Connectable::Port(port) => InstanceRef::new(
                        module_ref,
                        port.deref()
                            .parts
                            .iter()
                            .map(|p| p.deref().clone().into())
                            .collect(),
                    ),
                };

                let right_instance_ref = match right {
                    Connectable::Pin(signal) | Connectable::Signal(signal) => {
                        let signal_symbol: Symbol = signal.deref().clone().into();
                        let instance_ref =
                            InstanceRef::new(module_ref, vec![signal_symbol.clone()]);
                        self.add_instance(&instance_ref, Instance::port());
                        instance.add_child(&signal_symbol, &instance_ref);
                        instance_ref
                    }
                    Connectable::Port(port) => InstanceRef::new(
                        module_ref,
                        port.deref()
                            .parts
                            .iter()
                            .map(|p| p.deref().clone().into())
                            .collect(),
                    ),
                };

                if let Some(left_instance) = self.resolve_instance(&left_instance_ref) {
                    if !matches!(
                        left_instance.kind,
                        InstanceKind::Port | InstanceKind::Interface
                    ) {
                        return Err(EvaluatorError::new(
                            EvaluatorErrorKind::InvalidAssignment,
                            &connect.left.span().into_location(source),
                        )
                        .with_message(format!("Can't connect to `{}`", left_instance_ref)));
                    }
                } else {
                    return Err(EvaluatorError::new(
                        EvaluatorErrorKind::InvalidAssignment,
                        &connect.left.span().into_location(source),
                    )
                    .with_message(format!("`{}` does not exist", left_instance_ref)));
                }

                if let Some(right_instance) = self.resolve_instance(&right_instance_ref) {
                    if !matches!(
                        right_instance.kind,
                        InstanceKind::Port | InstanceKind::Interface
                    ) {
                        return Err(EvaluatorError::new(
                            EvaluatorErrorKind::InvalidAssignment,
                            &connect.right.span().into_location(source),
                        )
                        .with_message(format!("Can't connect to `{}`", right_instance_ref)));
                    }
                } else {
                    return Err(EvaluatorError::new(
                        EvaluatorErrorKind::InvalidAssignment,
                        &connect.right.span().into_location(source),
                    )
                    .with_message(format!("`{}` does not exist", right_instance_ref)));
                }

                instance
                    .connections
                    .push(Connection::new(left_instance_ref, right_instance_ref));

                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn evaluate_block(
        &mut self,
        source: &AtopileSource,
        file_scope: &mut FileScope,
        block: &BlockStmt,
    ) -> EvaluatorResult<()> {
        let module_ref = ModuleRef::new(source.path(), block.name.deref());
        let instance_kind = match block.kind.deref() {
            BlockKind::Module => InstanceKind::Module,
            BlockKind::Component => InstanceKind::Component,
            BlockKind::Interface => InstanceKind::Interface,
        };

        if let Some(parent) = &block.parent {
            let parent_module_ref = file_scope.resolve(parent).ok_or(EvaluatorError::new(
                EvaluatorErrorKind::TypeNotFound,
                &parent.span().into_location(source),
            ))?;

            self.clone_instance(&parent_module_ref.into(), &module_ref.clone().into())
                .map_err(|_| {
                    EvaluatorError::internal(
                        &parent.span().into_location(source),
                        "Failed to clone parent module".to_string(),
                    )
                })?;
        } else {
            let new_instance = Instance::new(&module_ref, instance_kind);
            self.add_instance(&module_ref.clone().into(), new_instance);
        };

        // Remove the instance so we can tinker with it before putting it back.
        let instance_ref: InstanceRef = module_ref.clone().into();
        let mut instance = self
            .remove_instance(&instance_ref)
            .ok_or(EvaluatorError::new(
                EvaluatorErrorKind::Internal,
                &block.name.span().into_location(source),
            ))?;

        for stmt in &block.body {
            if let Err(e) =
                self.evaluate_block_stmt(source, file_scope, &mut instance, &module_ref, stmt)
            {
                self.reporter.report(e.into());
            }
        }

        self.add_instance(&instance_ref, instance);
        file_scope.define(block.name.deref(), &module_ref);

        Ok(())
    }

    fn evaluate_top_stmt(
        &mut self,
        source: &AtopileSource,
        import_stack: &Vec<PathBuf>,
        file_scope: &mut FileScope,
        stmt: &Spanned<Stmt>,
    ) -> EvaluatorResult<()> {
        match stmt.deref() {
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
            Stmt::Block(block) => self.evaluate_block(source, file_scope, block),
            Stmt::Comment(_) => Ok(()),
            Stmt::Unparsable(_) => Err(EvaluatorError::new(
                EvaluatorErrorKind::UnparsableStmt,
                &stmt.span().into_location(source),
            )),
            _ => Err(EvaluatorError::new(
                EvaluatorErrorKind::UnexpectedStmt,
                &stmt.span().into_location(source),
            )),
        }
    }

    fn evaluate_inner(&mut self, source: &AtopileSource, import_stack: Vec<PathBuf>) {
        self.reporter.clear(source.path());

        let mut file_scope = FileScope::new();
        for stmt in source.ast() {
            if let Err(e) = self.evaluate_top_stmt(source, &import_stack, &mut file_scope, stmt) {
                self.reporter.report(e.into());
            }
        }
    }

    pub(crate) fn evaluate(&mut self, source: &AtopileSource) {
        log::info!("[evaluate] start: {:?}", source.path());
        let start = Instant::now();
        self.evaluate_inner(source, vec![]);
        let duration = start.elapsed();
        log::info!(
            "[evaluate] done: {:?} ({}ms)",
            source.path(),
            duration.as_millis()
        );
    }
}
