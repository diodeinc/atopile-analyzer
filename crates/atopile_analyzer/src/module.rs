use std::{collections::HashMap, sync::Arc};

use atopile_parser::parser::Connectable;
use serde::Serialize;

use crate::Location;

/// An Atopile `component` or `module`.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct Module {
    pub(crate) name: String,
    pub(crate) kind: ModuleKind,
    pub(crate) instantiations: HashMap<String, Instantiation>,
    pub(crate) interfaces: HashMap<String, Interface>,
    pub(crate) connections: Vec<Connection>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) enum ModuleKind {
    Component,
    Module,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct Instantiation {
    pub(crate) ident: String,
    pub(crate) module: Arc<Module>,
    pub(crate) location: Location,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct Interface {
    pub(crate) ident: String,
    pub(crate) interface: String,
    pub(crate) location: Location,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct Connection {
    pub(crate) left: Connectable,
    pub(crate) right: Connectable,
}
