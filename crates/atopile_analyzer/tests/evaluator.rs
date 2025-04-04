use atopile_analyzer::diagnostics::{
    AnalyzerDiagnostic, AnalyzerDiagnosticKind, AnalyzerDiagnosticSeverity,
};
use atopile_analyzer::evaluator::Evaluator;
use atopile_parser::AtopileSource;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
struct DiagnosticInfo {
    severity: String,
    kind: String,
    file: String,
}

impl From<&AnalyzerDiagnostic> for DiagnosticInfo {
    fn from(diag: &AnalyzerDiagnostic) -> Self {
        let severity = match diag.severity {
            AnalyzerDiagnosticSeverity::Error => "Error",
            AnalyzerDiagnosticSeverity::Warning => "Warning",
        };

        let kind = match &diag.kind {
            AnalyzerDiagnosticKind::UnconnectedInterface(_) => "UnconnectedInterface",
            AnalyzerDiagnosticKind::Evaluator(_) => "Evaluator",
        };

        Self {
            severity: severity.to_string(),
            kind: kind.to_string(),
            file: Path::new(&diag.file)
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_else(|| diag.file.to_string_lossy().to_string()),
        }
    }
}

#[derive(Debug, Serialize)]
struct EvaluatorTestResult {
    diagnostics: Vec<DiagnosticInfo>,
}

macro_rules! create_evaluator_test {
    ($name:ident) => {
        #[test]
        fn $name() {
            let input = fs::read_to_string(concat!(
                "tests/resources/corpus/",
                stringify!($name),
                ".ato"
            ))
            .unwrap();
            let normalized_input = input.replace("\r\n", "\n");

            let file_path = concat!("tests/resources/corpus/", stringify!($name), ".ato");
            let path_buf = PathBuf::from(file_path);

            let (source, _errors) = AtopileSource::new(
                normalized_input.to_string(),
                path_buf.clone(),
            );

            let mut evaluator = Evaluator::new();
            let state = evaluator.evaluate(&source);

            let diagnostics = evaluator.reporter()
                .diagnostics()
                .get(&path_buf)
                .map_or_else(Vec::new, |diags| {
                    diags.iter().map(DiagnosticInfo::from).collect()
                });

            let _state = state; // Use the state but don't include in snapshots
            
            let result = EvaluatorTestResult {
                diagnostics,
            };

            insta::with_settings!({
                sort_maps => true
            }, {
                insta::assert_yaml_snapshot!(result);
            });
        }
    };
}

create_evaluator_test!(simple_module);
create_evaluator_test!(simple_component);
create_evaluator_test!(simple_connection);
create_evaluator_test!(hoisted_declaration);
create_evaluator_test!(transitive_import);
