use atopile_analyzer::diagnostics::{
    AnalyzerDiagnostic, AnalyzerDiagnosticKind, AnalyzerDiagnosticSeverity,
};
use atopile_analyzer::evaluator::Evaluator;
use atopile_parser::AtopileSource;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

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
            AnalyzerDiagnosticKind::Evaluator(err) => &format!("Evaluator: {}", err),
        };

        Self {
            severity: severity.to_string(),
            kind: kind.to_string(),
            file: diag.file.to_string_lossy().to_string(),
        }
    }
}

#[derive(Debug, Serialize)]
struct EvaluatorTestResult {
    state: atopile_analyzer::evaluator::EvaluatorState,
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

            let source = Arc::new(AtopileSource::new(
                normalized_input.to_string(),
                path_buf.clone(),
            ));

            let mut evaluator = Evaluator::default();
            evaluator.set_source(&path_buf, source);
            let state = evaluator.evaluate();

            let diagnostics = evaluator.reporter()
                .diagnostics()
                .get(&path_buf)
                .map_or_else(Vec::new, |diags| {
                    diags.iter().map(DiagnosticInfo::from).collect()
                });

            let result = EvaluatorTestResult {
                state,
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
create_evaluator_test!(forward_reference);
create_evaluator_test!(cyclic_inheritance);
create_evaluator_test!(duplicate_declaration);
create_evaluator_test!(pin_connections);
create_evaluator_test!(dependency_ordering);
