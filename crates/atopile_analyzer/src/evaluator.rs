use std::{
    collections::HashMap,
    fs,
    ops::Deref,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

use atopile_parser::{
    parser::{BlockKind, BlockStmt, Connectable, Expr, Stmt, Symbol},
    AtopileSource, Spanned,
};
use fancy_regex::Regex;
use lazy_static::lazy_static;
use log::debug;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    diagnostics::AnalyzerReporter, AsLocation, IntoLocated, IntoLocation, Located, Location,
};

#[derive(Debug, Clone)]
struct BlockDeclaration {
    name: Symbol,
    parent: Option<Symbol>,
    location: Location,
    stmt: BlockStmt,
}

impl BlockDeclaration {
    fn new(block: &BlockStmt, location: Location) -> Self {
        Self {
            name: block.name.deref().clone(),
            parent: block.parent.as_ref().map(|p| p.deref().clone()),
            location,
            stmt: block.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct EvaluatorState {
    instances: HashMap<InstanceRef, Instance>,
}

impl EvaluatorState {
    fn new() -> Self {
        Self {
            instances: HashMap::new(),
        }
    }

    pub fn resolve_reference_designators(&mut self) {
        lazy_static! {
            static ref COMP_RE: Regex = Regex::new(r#"(?s)\(comp\s+\(ref\s+"([^"]+)"\)(?:(?!\(comp\s+).)*?sheetpath\s+\(names\s+"([^"]+)"\)"#).unwrap();
        }

        // Keep track of already processed netlists to avoid reading them multiple times
        let mut processed_netlists: HashMap<PathBuf, HashMap<String, String>> = HashMap::new();

        // First, collect all component instances
        let component_instances: Vec<_> = self
            .instances
            .iter()
            .filter(|(_, instance)| instance.kind == InstanceKind::Component)
            .map(|(instance_ref, _)| instance_ref.clone())
            .collect();

        for instance_ref in component_instances {
            // Convert instance path to filesystem path
            let source_path = &instance_ref.module.source_path;
            if let Some(source_dir) = source_path.parent() {
                // Walk up the directory tree to find ato.yaml
                let mut current_dir = source_dir;
                let mut found_root = false;

                // First check the current directory
                if current_dir.join("ato.yaml").exists() {
                    found_root = true;
                }

                // If not found, walk up the tree
                while !found_root {
                    match current_dir.parent() {
                        Some(parent) => {
                            current_dir = parent;
                            if current_dir.join("ato.yaml").exists() {
                                found_root = true;
                            }
                        }
                        None => break,
                    }
                }

                if !found_root {
                    continue;
                }

                // Look for the netlist file
                let netlist_path = current_dir.join("build").join("default.net");
                if !netlist_path.exists() {
                    continue;
                }

                // Get or create the cache for this netlist
                let ref_map = if let Some(map) = processed_netlists.get(&netlist_path) {
                    map
                } else {
                    // Read and parse the netlist file
                    match fs::read_to_string(&netlist_path) {
                        Ok(contents) => {
                            let mut map: HashMap<String, String> = HashMap::new();
                            for cap in COMP_RE.captures_iter(&contents) {
                                let ref_des = cap
                                    .as_ref()
                                    .expect("Failed to get captures")
                                    .get(1)
                                    .expect("Failed to get ref_des")
                                    .as_str();
                                let sheet_path = cap
                                    .as_ref()
                                    .expect("Failed to get captures")
                                    .get(2)
                                    .expect("Failed to get sheet_path")
                                    .as_str();
                                map.insert(sheet_path.to_string(), ref_des.to_string());
                            }
                            processed_netlists.insert(netlist_path.clone(), map);
                            processed_netlists.get(&netlist_path).unwrap()
                        }
                        Err(_) => continue,
                    }
                };

                // Convert our instance path format to netlist format
                // From: path/to/file.ato:RootModule.path.to.instance
                // To: /absolute/path/to/file.ato:RootModule::path.to.instance
                let instance_path = format!(
                    "{}:{}::{}",
                    source_path.display(),
                    instance_ref.module.module_name,
                    instance_ref
                        .instance_path
                        .iter()
                        .map(|s| s.to_string())
                        .collect::<Vec<_>>()
                        .join(".")
                );

                // Look up the reference designator
                if let Some(ref_des) = ref_map.get(&instance_path) {
                    if let Some(instance) = self.instances.get_mut(&instance_ref) {
                        instance.reference_designator = Some(ref_des.clone());
                    }
                }
            }
        }
    }
}

#[derive(Default)]
pub struct Evaluator {
    state: EvaluatorState,
    reporter: AnalyzerReporter,
    files: HashMap<PathBuf, Arc<AtopileSource>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
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

    fn pin() -> Self {
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

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(into = "String")]
pub(crate) struct InstanceRef {
    /// The root module that this instance belongs to.
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

    fn pop(&mut self) -> Option<Symbol> {
        self.instance_path.pop()
    }

    fn len(&self) -> usize {
        self.instance_path.len()
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

impl From<InstanceRef> for String {
    fn from(instance_ref: InstanceRef) -> Self {
        instance_ref.to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Copy, Serialize, Deserialize)]
pub(crate) enum InstanceKind {
    Module,
    Component,
    Interface,
    Port,
    Pin,
}

impl std::fmt::Display for InstanceKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) enum AttributeValue {
    String(String),
    Number(f64),
    Boolean(bool),
    Physical(String),
    Port(String),
    Array(Vec<AttributeValue>),
}

impl From<String> for AttributeValue {
    fn from(s: String) -> Self {
        AttributeValue::String(s)
    }
}

impl From<&str> for AttributeValue {
    fn from(s: &str) -> Self {
        AttributeValue::String(s.to_string())
    }
}

impl From<bool> for AttributeValue {
    fn from(b: bool) -> Self {
        AttributeValue::Boolean(b)
    }
}

impl From<f64> for AttributeValue {
    fn from(n: f64) -> Self {
        AttributeValue::Number(n)
    }
}

impl<T: Into<AttributeValue>> From<Vec<T>> for AttributeValue {
    fn from(v: Vec<T>) -> Self {
        AttributeValue::Array(v.into_iter().map(|x| x.into()).collect())
    }
}

impl From<&Expr> for AttributeValue {
    fn from(expr: &Expr) -> Self {
        match expr {
            Expr::String(s) => AttributeValue::String(s.deref().clone()),
            Expr::Number(n) => {
                if let Ok(num) = n.deref().parse::<f64>() {
                    AttributeValue::Number(num)
                } else {
                    // If parsing fails, store as string
                    AttributeValue::String(n.deref().clone())
                }
            }
            Expr::Bool(b) => AttributeValue::Boolean(*b.deref()),
            Expr::Physical(p) => AttributeValue::Physical(p.deref().to_string()),
            Expr::Port(p) => AttributeValue::Port(p.deref().to_string()),
            // For other types, convert to string representation
            _ => AttributeValue::String("".to_string()),
        }
    }
}

impl From<Expr> for AttributeValue {
    fn from(expr: Expr) -> Self {
        (&expr).into()
    }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct Instance {
    type_ref: ModuleRef,
    kind: InstanceKind,
    attributes: HashMap<Symbol, AttributeValue>,
    children: HashMap<Symbol, InstanceRef>,
    connections: Vec<Connection>,
    reference_designator: Option<String>,
}

impl Instance {
    fn new(module: &ModuleRef, kind: InstanceKind) -> Self {
        Self {
            type_ref: module.clone(),
            kind,
            attributes: HashMap::new(),
            children: HashMap::new(),
            connections: Vec::new(),
            reference_designator: None,
        }
    }

    fn port() -> Self {
        Self {
            type_ref: ModuleRef::port(),
            kind: InstanceKind::Port,
            attributes: HashMap::new(),
            children: HashMap::new(),
            connections: Vec::new(),
            reference_designator: None,
        }
    }

    fn pin() -> Self {
        Self {
            type_ref: ModuleRef::pin(),
            kind: InstanceKind::Pin,
            attributes: HashMap::new(),
            children: HashMap::new(),
            connections: Vec::new(),
            reference_designator: None,
        }
    }

    fn add_attribute(&mut self, attribute: &Symbol, value: impl Into<AttributeValue>) {
        self.attributes.insert(attribute.clone(), value.into());
    }

    fn add_child(&mut self, child: &Symbol, instance_ref: &InstanceRef) {
        self.children.insert(child.clone(), instance_ref.clone());
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
        debug!("Creating EvaluatorError: {:?} @ {:?}", kind, location);
        Self {
            kind,
            location: location.clone(),
            message: None,
        }
    }

    fn internal<T: AsLocation>(location: &T, message: String) -> Self {
        Self::new(EvaluatorErrorKind::Internal, &location.as_location()).with_message(message)
    }

    fn invalid_connection<T: AsLocation>(location: &T, message: String) -> Self {
        Self::new(
            EvaluatorErrorKind::InvalidConnection,
            &location.as_location(),
        )
        .with_message(message)
    }

    fn with_message(mut self, message: String) -> Self {
        debug!(
            "Adding message to EvaluatorError: {:?} @ {:?} = {}",
            self.kind, self.location, message
        );
        self.message = Some(message);
        self
    }
}

#[derive(Debug, Clone, Error)]
pub enum EvaluatorErrorKind {
    #[error("import path not found")]
    ImportPathNotFound,
    #[error("cyclic import detected")]
    ImportCycle,
    #[error("failed to load import")]
    ImportLoadFailed,
    #[error("symbol not found")]
    ImportNotFound,
    #[error("unexpected statement")]
    UnexpectedStmt,
    #[error("type not found")]
    TypeNotFound,
    #[error("invalid assignment")]
    InvalidAssignment,
    #[error("invalid connection")]
    InvalidConnection,
    #[error("parse error")]
    ParseError,
    #[error("duplicate declaration")]
    DuplicateDeclaration,
    #[error("cyclic inheritance detected")]
    CyclicInheritance,

    #[error("internal error")]
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
                location: spanned.span().to_location(source),
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
        self.ok_or_else(|| EvaluatorError::new(kind(()), &spanned.span().to_location(source)))
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
        if dir.file_name().is_some_and(|name| name == ".ato") {
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
    pub fn new() -> Self {
        debug!("Creating new Evaluator instance");
        Self {
            state: EvaluatorState::new(),
            reporter: AnalyzerReporter::new(),
            files: HashMap::new(),
        }
    }
}

impl Evaluator {
    pub fn reset(&mut self) {
        self.state = EvaluatorState::new();
        self.reporter.reset();
    }

    pub fn reporter(&self) -> &AnalyzerReporter {
        &self.reporter
    }

    fn resolve_instance(&self, instance_ref: &InstanceRef) -> Option<&Instance> {
        debug!("Resolving instance: {}", instance_ref);
        self.state.instances.get(instance_ref)
    }

    fn resolve_instance_mut(&mut self, instance_ref: &InstanceRef) -> Option<&mut Instance> {
        self.state.instances.get_mut(instance_ref)
    }

    fn add_instance(&mut self, instance_ref: &InstanceRef, instance: Instance) {
        debug!(
            "Adding instance: {} of kind {:?}",
            instance_ref, instance.kind
        );
        self.state.instances.insert(instance_ref.clone(), instance);
    }

    fn remove_instance(&mut self, instance_ref: &InstanceRef) -> Option<Instance> {
        self.state.instances.remove(instance_ref)
    }

    fn clone_instance(
        &mut self,
        from_ref: &InstanceRef,
        to_ref: &InstanceRef,
    ) -> anyhow::Result<()> {
        debug!("Cloning instance from {} to {}", from_ref, to_ref);
        let (mut to_instance, children, connections) = {
            let from_instance = self.resolve_instance(from_ref).ok_or_else(|| {
                anyhow::anyhow!(
                    "Tried to clone instance `{}` but it doesn't exist",
                    from_ref
                )
            })?;

            let mut to_instance = Instance::new(&from_instance.type_ref, from_instance.kind);

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
            self.clone_instance(v, &transposed_ref)?;
            to_instance.add_child(k, &transposed_ref);
        }

        for connection in &connections {
            // Strip from_ref.instance_path from the beginning of connection.left.instance_path
            // and replace it with to_ref.instance_path
            let left_relative_path = if connection
                .left
                .instance_path
                .starts_with(&from_ref.instance_path)
            {
                // Get the part after from_ref.instance_path
                connection.left.instance_path[from_ref.instance_path.len()..].to_vec()
            } else {
                connection.left.instance_path.clone()
            };

            // Same for right path
            let right_relative_path = if connection
                .right
                .instance_path
                .starts_with(&from_ref.instance_path)
            {
                // Get the part after from_ref.instance_path
                connection.right.instance_path[from_ref.instance_path.len()..].to_vec()
            } else {
                connection.right.instance_path.clone()
            };

            let new_left = InstanceRef::new(
                &to_ref.module,
                [to_ref.instance_path.clone(), left_relative_path].concat(),
            );

            let new_right = InstanceRef::new(
                &to_ref.module,
                [to_ref.instance_path.clone(), right_relative_path].concat(),
            );

            let connection = Connection::new(new_left.clone(), new_right.clone());
            to_instance.connections.push(connection);
        }

        self.add_instance(to_ref, to_instance);

        Ok(())
    }

    fn connect(
        &mut self,
        instance: &mut Instance,
        source: &Located<InstanceRef>,
        target: &Located<InstanceRef>,
        assignment: &Located<Stmt>,
    ) -> EvaluatorResult<()> {
        debug!(
            "Connecting instances: {} -> {}",
            source.deref(),
            target.deref()
        );
        let left_instance = self.resolve_instance(source).ok_or_else(|| {
            EvaluatorError::invalid_connection(
                source,
                format!("`{}` does not exist", source.deref()),
            )
        })?;

        let right_instance = self.resolve_instance(target).ok_or_else(|| {
            EvaluatorError::invalid_connection(
                target,
                format!("`{}` does not exist", target.deref()),
            )
        })?;

        let connections = match (left_instance.kind, right_instance.kind) {
            (InstanceKind::Port, InstanceKind::Port)
            | (InstanceKind::Pin, InstanceKind::Pin)
            | (InstanceKind::Port, InstanceKind::Pin)
            | (InstanceKind::Pin, InstanceKind::Port) => {
                vec![Connection::new(
                    source.deref().clone(),
                    target.deref().clone(),
                )]
            }
            (InstanceKind::Interface, InstanceKind::Interface) => {
                if left_instance.type_ref != right_instance.type_ref {
                    return Err(EvaluatorError::new(
                        EvaluatorErrorKind::InvalidAssignment,
                        assignment.location(),
                    )
                    .with_message(format!(
                        "cannot connect interfaces of different type: `{}` and `{}`",
                        left_instance.type_ref, right_instance.type_ref
                    )));
                }

                let mut left_sorted: Vec<_> = left_instance.children.iter().collect();
                let mut right_sorted: Vec<_> = right_instance.children.iter().collect();

                // Sort by the key (Symbol)
                left_sorted.sort_by(|a, b| a.0.cmp(b.0));
                right_sorted.sort_by(|a, b| a.0.cmp(b.0));

                left_sorted
                    .into_iter()
                    .zip(right_sorted)
                    .map(|((_, l), (_, r))| Connection::new(l.clone(), r.clone()))
                    .collect()
            }
            _ => {
                return Err(EvaluatorError::new(
                    EvaluatorErrorKind::InvalidAssignment,
                    assignment.location(),
                )
                .with_message(format!(
                    "Cannot connect instances of different kind: `{}` and `{}`",
                    left_instance.kind, right_instance.kind
                )));
            }
        };

        for connection in connections {
            let left_path = &connection.left.instance_path;
            let right_path = &connection.right.instance_path;

            if connection.left.module != connection.right.module {
                return Err(EvaluatorError::new(
                    EvaluatorErrorKind::InvalidAssignment,
                    assignment.location(),
                )
                .with_message(format!(
                    "Cannot connect interfaces across modules: `{}` and `{}`",
                    connection.left.module, connection.right.module
                )));
            }

            // Determine the common prefix length
            let common_prefix_len = left_path
                .iter()
                .zip(right_path.iter())
                .take_while(|(a, b)| a == b)
                .count();

            if common_prefix_len == 0 {
                instance.connections.push(connection);
            } else {
                // Create a reference to the common ancestor
                let common_ancestor_path = left_path[0..common_prefix_len].to_vec();
                let common_ancestor_ref =
                    InstanceRef::new(&source.module, common_ancestor_path.clone());

                self.resolve_instance_mut(&common_ancestor_ref)
                    .ok_or_else(|| {
                        EvaluatorError::invalid_connection(
                            assignment,
                            format!("`{}` does not exist", common_ancestor_ref),
                        )
                    })?
                    .connections
                    .push(connection);
            }
        }

        Ok(())
    }

    fn get_or_load_source(&mut self, path: &PathBuf) -> anyhow::Result<Arc<AtopileSource>> {
        if let Some(source) = self.files.get(path) {
            Ok(source.clone())
        } else {
            let content = std::fs::read_to_string(path)?;
            let source = Arc::new(AtopileSource::new(content, path.to_path_buf()));
            self.files.insert(path.to_path_buf(), source.clone());
            Ok(source)
        }
    }

    fn evaluate_import(
        &mut self,
        source: &AtopileSource,
        import_stack: &[PathBuf],
        file_scope: &mut FileScope,
        import_path: &Spanned<String>,
        import_symbols: &[Spanned<Symbol>],
    ) -> EvaluatorResult<()> {
        debug!(
            "Evaluating import: {} with {} symbols",
            import_path.deref(),
            import_symbols.len()
        );
        debug!("Import stack depth: {}", import_stack.len());
        // Fast path: check if we already evaluated this module.
        let mut load_file = false;
        for symbol in import_symbols {
            if let Some(resolved_path) =
                resolve_import_path(source.path(), Path::new(import_path.deref()))
            {
                let module_ref = ModuleRef::new(&resolved_path, symbol.deref());
                if let Some(instance) = self.resolve_instance(&module_ref.into()) {
                    file_scope.define(symbol.deref(), &instance.type_ref);
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
                import_path,
            )?;

        // Check for cycles.
        if import_stack.iter().any(|p| p == &path) {
            return Err(EvaluatorError::new(
                EvaluatorErrorKind::ImportCycle,
                &import_path.span().to_location(source),
            ));
        }

        // Load and evaluate the imported module.
        let imported_source = self.get_or_load_source(&path).with_context(
            source,
            |_| EvaluatorErrorKind::ImportLoadFailed,
            import_path,
        )?;

        let mut import_stack_vec = import_stack.to_vec();
        import_stack_vec.push(path.clone());

        self.evaluate_inner(&imported_source, import_stack_vec);

        // Define the imported symbols.
        for imported_symbol in import_symbols {
            let instance_ref = ModuleRef::new(&path, imported_symbol.deref()).into();

            if let Some(instance) = self.resolve_instance(&instance_ref) {
                file_scope.define(imported_symbol.deref(), &instance.type_ref);
            } else {
                self.reporter.report(
                    EvaluatorError::new(
                        EvaluatorErrorKind::ImportNotFound,
                        &imported_symbol.span().to_location(source),
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
        debug!("Evaluating block statement in module: {}", module_ref);
        match stmt.deref() {
            // x.y.z = ...
            Stmt::Assign(assign) => {
                debug!(
                    "Processing assignment statement to target: {:?}",
                    assign.target.deref()
                );
                let mut target_ref = InstanceRef::new(
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
                                &assign.target.span().to_location(source),
                            )
                            .with_message("Cannot create new module in sub-module".to_string()));
                        }

                        // Get a reference to the module that we're creating.
                        let child_name = assign.target.deref().parts.last().unwrap();
                        let type_module_ref = file_scope.resolve(type_name).ok_or_else(|| {
                            EvaluatorError::new(
                                EvaluatorErrorKind::TypeNotFound,
                                &type_name.span().to_location(source),
                            )
                        })?;

                        // Cannot create a child that already exists.
                        if self.resolve_instance(&target_ref).is_some() {
                            return Err(EvaluatorError::new(
                                EvaluatorErrorKind::InvalidAssignment,
                                &assign.target.span().to_location(source),
                            )
                            .with_message(format!("`{}` already exists", child_name.deref())));
                        }

                        // Create the child instance.
                        self.clone_instance(&type_module_ref.into(), &target_ref)
                            .map_err(|e| {
                                EvaluatorError::internal(
                                    &assign.target.span().to_location(source),
                                    format!(
                                        "Failed to clone instance `{}`: {}",
                                        type_module_ref, e
                                    ),
                                )
                            })?;

                        instance.add_child(&child_name.clone().deref().deref().into(), &target_ref);
                    }
                    _ => {
                        // Handle attribute assignment using the new From<Expr> implementation
                        let attr_name = target_ref.pop().ok_or_else(|| {
                            EvaluatorError::new(
                                EvaluatorErrorKind::InvalidAssignment,
                                &assign.value.span().to_location(source),
                            )
                            .with_message("Cannot assign attribute to top-level module".to_string())
                        })?;

                        let attr_value: AttributeValue = assign.value.deref().into();

                        if target_ref.len() == 0 {
                            instance.add_attribute(&attr_name, attr_value);
                        } else {
                            let target_instance =
                                self.resolve_instance_mut(&target_ref).ok_or_else(|| {
                                    EvaluatorError::new(
                                        EvaluatorErrorKind::InvalidAssignment,
                                        &assign.value.span().to_location(source),
                                    )
                                })?;

                            target_instance.add_attribute(&attr_name, attr_value);
                        }
                    }
                }
                Ok(())
            }
            Stmt::Signal(signal) => {
                debug!("Processing signal statement: {}", signal.name.deref());
                let signal_name = signal.name.deref();
                let signal_ref = InstanceRef::new(module_ref, vec![signal_name.clone()]);
                self.add_instance(&signal_ref, Instance::port());
                instance.add_child(signal_name, &signal_ref);
                Ok(())
            }
            Stmt::Pin(pin) => {
                debug!("Processing pin statement: {}", pin.name.deref());
                let pin_name = pin.name.deref();
                let pin_ref = InstanceRef::new(module_ref, vec![pin_name.clone()]);
                self.add_instance(&pin_ref, Instance::pin());
                instance.add_child(pin_name, &pin_ref);
                Ok(())
            }
            Stmt::Connect(connect) => {
                debug!("Processing connect statement");
                let left = connect.left.deref();
                let right = connect.right.deref();

                // Handle implicit signal definitions and pull out the ConnectionHandle for each.
                let left_instance_ref = match left {
                    Connectable::Signal(signal) => {
                        let signal_symbol: Symbol = signal.deref().clone().into();
                        let instance_ref =
                            InstanceRef::new(module_ref, vec![signal_symbol.clone()]);
                        self.add_instance(&instance_ref, Instance::port());
                        instance.add_child(&signal_symbol, &instance_ref);
                        Some(instance_ref)
                    }
                    Connectable::Port(port) => Some(InstanceRef::new(
                        module_ref,
                        port.deref()
                            .parts
                            .iter()
                            .map(|p| p.deref().clone().into())
                            .collect(),
                    )),
                    Connectable::Pin(pin) => {
                        let pin_symbol: Symbol = pin.deref().clone().into();
                        let instance_ref = InstanceRef::new(module_ref, vec![pin_symbol.clone()]);
                        self.add_instance(&instance_ref, Instance::pin());
                        instance.add_child(&pin_symbol, &instance_ref);
                        Some(instance_ref)
                    }
                };

                let right_instance_ref = match right {
                    Connectable::Signal(signal) => {
                        let signal_symbol: Symbol = signal.deref().clone().into();
                        let instance_ref =
                            InstanceRef::new(module_ref, vec![signal_symbol.clone()]);
                        self.add_instance(&instance_ref, Instance::port());
                        instance.add_child(&signal_symbol, &instance_ref);
                        Some(instance_ref)
                    }
                    Connectable::Port(port) => Some(InstanceRef::new(
                        module_ref,
                        port.deref()
                            .parts
                            .iter()
                            .map(|p| p.deref().clone().into())
                            .collect(),
                    )),
                    Connectable::Pin(pin) => {
                        let pin_symbol: Symbol = pin.deref().clone().into();
                        let instance_ref = InstanceRef::new(module_ref, vec![pin_symbol.clone()]);
                        self.add_instance(&instance_ref, Instance::pin());
                        instance.add_child(&pin_symbol, &instance_ref);
                        Some(instance_ref)
                    }
                };

                if let (Some(left), Some(right)) = (left_instance_ref, right_instance_ref) {
                    self.connect(
                        instance,
                        &Located::new(left, connect.left.span().to_location(source)),
                        &Located::new(right, connect.right.span().to_location(source)),
                        &stmt.clone().into_located(source),
                    )?;
                }

                Ok(())
            }
            _ => {
                debug!("Skipping unhandled statement type");
                Ok(())
            }
        }
    }

    fn evaluate_block(
        &mut self,
        source: &AtopileSource,
        file_scope: &mut FileScope,
        block: &BlockStmt,
    ) -> EvaluatorResult<()> {
        debug!(
            "Evaluating block: {} of kind {:?}",
            block.name.deref(),
            block.kind.deref()
        );
        let module_ref = ModuleRef::new(source.path(), block.name.deref());
        let instance_kind = match block.kind.deref() {
            BlockKind::Module => InstanceKind::Module,
            BlockKind::Component => InstanceKind::Component,
            BlockKind::Interface => InstanceKind::Interface,
        };

        if let Some(parent) = &block.parent {
            let parent_module_ref = file_scope.resolve(parent).ok_or_else(|| {
                EvaluatorError::new(
                    EvaluatorErrorKind::TypeNotFound,
                    &parent.span().to_location(source),
                )
            })?;

            self.clone_instance(&parent_module_ref.into(), &module_ref.clone().into())
                .map_err(|_| {
                    EvaluatorError::internal(
                        &parent.span().to_location(source),
                        "Failed to clone parent module".to_string(),
                    )
                })?;
        } else {
            let new_instance = Instance::new(&module_ref, instance_kind);
            self.add_instance(&module_ref.clone().into(), new_instance);
        };

        // Remove the instance so we can tinker with it before putting it back.
        let instance_ref: InstanceRef = module_ref.clone().into();
        let mut instance = self.remove_instance(&instance_ref).ok_or_else(|| {
            EvaluatorError::new(
                EvaluatorErrorKind::Internal,
                &block.name.span().to_location(source),
            )
        })?;

        instance.type_ref = module_ref.clone();

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
        import_stack: &[PathBuf],
        file_scope: &mut FileScope,
        stmt: &Spanned<Stmt>,
    ) -> EvaluatorResult<()> {
        debug!("Evaluating top-level statement");
        match stmt.deref() {
            Stmt::Import(import) => {
                debug!(
                    "Processing import statement from: {}",
                    import.from_path.deref()
                );
                self.evaluate_import(
                    source,
                    import_stack,
                    file_scope,
                    &import.from_path,
                    &import.imports,
                )
            }
            Stmt::DepImport(dep_import) => {
                debug!(
                    "Processing dependency import from: {}",
                    dep_import.from_path.deref()
                );
                self.evaluate_import(
                    source,
                    import_stack,
                    file_scope,
                    &dep_import.from_path,
                    &[dep_import.name.clone()],
                )
            }
            Stmt::Block(block) => {
                debug!("Processing block statement: {}", block.name.deref());
                self.evaluate_block(source, file_scope, block)
            }
            Stmt::Comment(_) => Ok(()),
            Stmt::ParseError(err) => {
                self.reporter.report(
                    EvaluatorError::new(
                        EvaluatorErrorKind::ParseError,
                        &stmt.span().to_location(source),
                    )
                    .with_message(err.to_string())
                    .into(),
                );
                Ok(())
            }
            _ => Err(EvaluatorError::new(
                EvaluatorErrorKind::UnexpectedStmt,
                &stmt.span().to_location(source),
            )),
        }
    }

    fn collect_block_declarations(&mut self, source: &AtopileSource) -> Vec<BlockDeclaration> {
        debug!(
            "Collecting block declarations from source: {:?}",
            source.path()
        );
        let mut declarations = Vec::new();
        let mut seen_names = HashMap::new();

        for stmt in source.ast() {
            if let Stmt::Block(block) = stmt.deref() {
                let location = stmt.span().to_location(source);
                let name = block.name.deref();

                // Check for duplicate declarations
                if let Some(prev_loc) = seen_names.get(name) {
                    self.reporter.report(
                        EvaluatorError::new(EvaluatorErrorKind::DuplicateDeclaration, &location)
                            .with_message(format!(
                                "Block '{}' is already declared at {:?}",
                                name, prev_loc
                            ))
                            .into(),
                    );
                    continue;
                }

                seen_names.insert(name.clone(), location.clone());
                declarations.push(BlockDeclaration::new(block, location));
            }
        }

        declarations
    }

    fn sort_blocks<'a>(
        &mut self,
        declarations: &'a [BlockDeclaration],
    ) -> Vec<&'a BlockDeclaration> {
        debug!("Sorting {} block declarations", declarations.len());
        let mut sorted = Vec::new();
        let mut visited = HashMap::new();
        let mut temp_mark = HashMap::new();

        // Helper function for depth-first topological sort
        fn visit<'a>(
            block: &'a BlockDeclaration,
            declarations: &'a [BlockDeclaration],
            sorted: &mut Vec<&'a BlockDeclaration>,
            visited: &mut HashMap<Symbol, bool>,
            temp_mark: &mut HashMap<Symbol, bool>,
            reporter: &mut AnalyzerReporter,
        ) {
            // If we've already visited this node, return
            if visited.get(&block.name).copied().unwrap_or(false) {
                return;
            }

            // Check for cycles
            if temp_mark.get(&block.name).copied().unwrap_or(false) {
                reporter.report(
                    EvaluatorError::new(EvaluatorErrorKind::CyclicInheritance, &block.location)
                        .with_message(format!(
                            "Cyclic inheritance detected involving '{}'",
                            block.name
                        ))
                        .into(),
                );
                return;
            }

            // Mark temporarily for cycle detection
            temp_mark.insert(block.name.clone(), true);

            // If this block has a parent, visit it first
            if let Some(parent_name) = &block.parent {
                if let Some(parent) = declarations.iter().find(|d| &d.name == parent_name) {
                    visit(parent, declarations, sorted, visited, temp_mark, reporter);
                }
            }

            // Remove temporary mark and add to visited
            temp_mark.remove(&block.name);
            visited.insert(block.name.clone(), true);
            sorted.push(block);
        }

        // Visit all nodes
        for block in declarations {
            if !visited.get(&block.name).copied().unwrap_or(false) {
                visit(
                    block,
                    declarations,
                    &mut sorted,
                    &mut visited,
                    &mut temp_mark,
                    &mut self.reporter,
                );
            }
        }

        sorted
    }

    fn evaluate_inner(&mut self, source: &AtopileSource, import_stack: Vec<PathBuf>) {
        debug!("Starting inner evaluation of source: {:?}", source.path());
        debug!("Import stack depth: {}", import_stack.len());
        self.reporter.clear(source.path());

        let mut file_scope = FileScope::new();

        // Phase 1: Collect block declarations
        let block_declarations = self.collect_block_declarations(source);

        // Phase 2: Sort blocks by inheritance dependencies
        let sorted_blocks = self.sort_blocks(&block_declarations);

        // Phase 3: Pre-register all blocks in scope
        for block in &block_declarations {
            let module_ref = ModuleRef::new(source.path(), &block.name);
            file_scope.define(&block.name, &module_ref);
        }

        // Phase 4: Process all non-block statements
        for stmt in source.ast() {
            if !matches!(stmt.deref(), Stmt::Block(_)) {
                if let Err(e) = self.evaluate_top_stmt(source, &import_stack, &mut file_scope, stmt)
                {
                    self.reporter.report(e.into());
                }
            }
        }

        // Phase 5: Evaluate blocks in dependency order
        for block in sorted_blocks {
            if let Err(e) = self.evaluate_block(source, &mut file_scope, &block.stmt) {
                self.reporter.report(e.into());
            }
        }
    }

    pub fn set_source(&mut self, path: &Path, source: Arc<AtopileSource>) {
        self.files.insert(path.to_path_buf(), source);
        self.evaluate();
    }

    pub fn remove_source(&mut self, path: &Path) {
        self.files.remove(path);
        self.evaluate();
    }

    pub fn resolve_reference_designators(&mut self) {
        self.state.resolve_reference_designators();
    }

    pub fn state(&self) -> &EvaluatorState {
        &self.state
    }

    fn evaluate(&mut self) -> EvaluatorState {
        debug!("Evaluator starting evaluation");
        let start = Instant::now();
        self.reset();

        let files_to_evaluate: Vec<_> = self.files.values().cloned().collect();

        for source in files_to_evaluate {
            self.evaluate_inner(&source, vec![]);
        }

        let duration = start.elapsed();
        debug!("Evaluation completed in {}ms", duration.as_millis());
        debug!(
            "Final state contains {} instances",
            self.state.instances.len()
        );

        self.state.clone()
    }
}
