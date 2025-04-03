use std::{
    cell::{Ref, RefCell},
    collections::HashMap,
    path::{Path, PathBuf},
};

use crate::{evaluator::EvaluatorError, Location};

/// A diagnostic from the analyzer.
#[derive(Debug, Clone)]
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

#[derive(Debug, Clone)]
pub enum AnalyzerDiagnosticKind {
    UnconnectedInterface(UnconnectedInterfaceDiagnostic),
    Evaluator(EvaluatorError),
}

impl From<EvaluatorError> for AnalyzerDiagnostic {
    fn from(error: EvaluatorError) -> Self {
        let file = error.location.file.clone();
        Self {
            severity: AnalyzerDiagnosticSeverity::Error,
            kind: AnalyzerDiagnosticKind::Evaluator(error),
            file,
        }
    }
}
pub struct AnalyzerReporter {
    diagnostics: RefCell<HashMap<PathBuf, Vec<AnalyzerDiagnostic>>>,
}

impl AnalyzerReporter {
    pub fn new() -> Self {
        Self {
            diagnostics: RefCell::new(HashMap::new()),
        }
    }
}

impl Default for AnalyzerReporter {
    fn default() -> Self {
        Self::new()
    }
}

impl AnalyzerReporter {
    pub fn reset(&self) {
        self.diagnostics.borrow_mut().clear();
    }

    pub fn clear(&self, path: &Path) {
        self.diagnostics
            .borrow_mut()
            .entry(path.to_path_buf())
            .or_default()
            .clear();
    }

    pub fn report(&self, diagnostic: AnalyzerDiagnostic) {
        self.diagnostics
            .borrow_mut()
            .entry(diagnostic.file.clone())
            .or_default()
            .push(diagnostic);
    }

    pub fn diagnostics(&self) -> Ref<'_, HashMap<PathBuf, Vec<AnalyzerDiagnostic>>> {
        self.diagnostics.borrow()
    }
}

#[derive(Debug, Clone)]
pub struct UnconnectedInterfaceDiagnostic {
    pub instance_name: String,
    pub interface_name: String,

    pub instantiation_location: Location,
    pub interface_location: Location,
}
