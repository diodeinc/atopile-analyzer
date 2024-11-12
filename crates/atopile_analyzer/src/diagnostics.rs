use std::path::PathBuf;

use crate::Location;

/// A diagnostic from the analyzer.
#[derive(Debug)]
pub struct AnalyzerDiagnostic {
    pub severity: AnalyzerDiagnosticSeverity,
    pub kind: AnalyzerDiagnosticKind,
    pub file: PathBuf,
}

#[derive(Debug, Copy, Clone)]
pub enum AnalyzerDiagnosticSeverity {
    Error,
    Warning,
}

#[derive(Debug)]
pub enum AnalyzerDiagnosticKind {
    UnconnectedInterface(UnconnectedInterfaceDiagnostic),
}

#[derive(Debug)]
pub struct UnconnectedInterfaceDiagnostic {
    pub instance_name: String,
    pub interface_name: String,

    pub instantiation_location: Location,
    pub interface_location: Location,
}
