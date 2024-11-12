use std::collections::HashMap;
use std::path::PathBuf;

use atopile_analyzer::diagnostics::{
    AnalyzerDiagnostic, AnalyzerDiagnosticKind, AnalyzerDiagnosticSeverity,
};
use atopile_analyzer::AtopileAnalyzer;
use atopile_parser::AtopileSource;
use log::{info, Level, LevelFilter, Log, Metadata, Record};
use tokio::sync::Mutex;
use tower_lsp::jsonrpc::Result;
use tower_lsp::lsp_types::*;
use tower_lsp::{Client, LanguageServer, LspService, Server};

struct Backend {
    client: Client,
    analyzer: Mutex<AtopileAnalyzer>,
}

struct LspLogger {
    client: Client,
}

impl Log for LspLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= Level::Warn
    }

    fn log(&self, record: &Record) {
        if self.enabled(record.metadata()) {
            let message_type = match record.level() {
                Level::Error => MessageType::ERROR,
                Level::Warn => MessageType::WARNING,
                Level::Info => MessageType::INFO,
                Level::Debug | Level::Trace => MessageType::LOG,
            };

            let client = self.client.clone();
            let message = record.args().to_string();
            tokio::spawn(async move {
                client.log_message(message_type, message).await;
            });
        }
    }

    fn flush(&self) {}
}

fn position_to_lsp(pos: atopile_parser::Position) -> Position {
    Position {
        line: pos.line as u32,
        character: pos.column as u32,
    }
}

fn position_from_lsp(pos: Position) -> atopile_parser::Position {
    atopile_parser::Position {
        line: pos.line as usize,
        column: pos.character as usize,
    }
}

fn range_to_lsp(range: atopile_analyzer::Range) -> Range {
    Range {
        start: position_to_lsp(range.start),
        end: position_to_lsp(range.end),
    }
}

fn diagnostic_severity_to_lsp(severity: AnalyzerDiagnosticSeverity) -> DiagnosticSeverity {
    match severity {
        AnalyzerDiagnosticSeverity::Error => DiagnosticSeverity::ERROR,
        AnalyzerDiagnosticSeverity::Warning => DiagnosticSeverity::WARNING,
    }
}

fn diagnostic_to_lsp(diag: &AnalyzerDiagnostic) -> Diagnostic {
    match &diag.kind {
        AnalyzerDiagnosticKind::UnconnectedInterface(unconnected_diag) => Diagnostic {
            range: range_to_lsp(unconnected_diag.instantiation_location.range),
            severity: Some(diagnostic_severity_to_lsp(diag.severity)),
            message: format!(
                "{} defines interface {}, which isn't connected in this module",
                unconnected_diag.instance_name, unconnected_diag.interface_name
            ),
            ..Default::default()
        },
    }
}

impl Backend {
    fn new(client: Client) -> Self {
        // Initialize logger
        let logger = LspLogger {
            client: client.clone(),
        };
        log::set_boxed_logger(Box::new(logger))
            .map(|()| log::set_max_level(LevelFilter::Info))
            .expect("Failed to initialize logger");

        Self {
            client,
            analyzer: Mutex::new(AtopileAnalyzer::new()),
        }
    }

    async fn update_source(&self, text: &str, uri: &Url) -> anyhow::Result<()> {
        let path = uri
            .to_file_path()
            .expect("Failed to convert URI to file path");
        let source = AtopileSource::new(text.to_string(), path.clone())
            .map_err(|e| anyhow::anyhow!("Failed to parse source: {:?}", e))?;

        let mut analyzer = self.analyzer.lock().await;
        analyzer
            .set_source(
                &uri.to_file_path()
                    .expect("Failed to convert URI to file path"),
                source,
            )
            .map_err(|e| anyhow::anyhow!("Failed to set source: {:?}", e))?;

        let diagnostics = analyzer
            .diagnostics(&path)
            .map_err(|e| anyhow::anyhow!("Failed to get diagnostics: {:?}", e))?;

        let mut diagnostics_per_file = HashMap::<PathBuf, Vec<AnalyzerDiagnostic>>::new();
        for diag in diagnostics {
            diagnostics_per_file
                .entry(diag.file.clone())
                .or_default()
                .push(diag);
        }

        for (file, diagnostics) in diagnostics_per_file {
            let lsp_diagnostics = diagnostics.iter().map(|d| diagnostic_to_lsp(d)).collect();

            info!("publishing diagnostics: {:?}", lsp_diagnostics);

            self.client
                .publish_diagnostics(
                    Url::from_file_path(&file).expect("Failed to convert file path to URI"),
                    lsp_diagnostics,
                    None,
                )
                .await;
        }

        Ok(())
    }
}

#[tower_lsp::async_trait]
impl LanguageServer for Backend {
    async fn initialize(&self, _: InitializeParams) -> Result<InitializeResult> {
        Ok(InitializeResult {
            capabilities: ServerCapabilities {
                text_document_sync: Some(TextDocumentSyncCapability::Kind(
                    TextDocumentSyncKind::FULL,
                )),
                definition_provider: Some(OneOf::Left(true)),
                ..Default::default()
            },
            server_info: Some(ServerInfo {
                name: "atopile_lsp".to_string(),
                version: Some(env!("CARGO_PKG_VERSION").to_string()),
            }),
            ..Default::default()
        })
    }

    async fn initialized(&self, _: InitializedParams) {
        info!("server initialized!");
    }

    async fn did_open(&self, params: DidOpenTextDocumentParams) {
        info!("did_open");

        let res = self
            .update_source(&params.text_document.text, &params.text_document.uri)
            .await;

        match res {
            Ok(_) => (),
            Err(errors) => {
                self.client
                    .log_message(MessageType::ERROR, format!("{:?}", errors))
                    .await;
            }
        }
    }

    async fn did_change(&self, params: DidChangeTextDocumentParams) {
        info!("did_change");

        let res = self
            .update_source(
                &params.content_changes.first().unwrap().text,
                &params.text_document.uri,
            )
            .await;

        match res {
            Ok(_) => (),
            Err(errors) => {
                self.client
                    .log_message(MessageType::ERROR, format!("{:?}", errors))
                    .await;
            }
        }
    }

    async fn did_close(&self, params: DidCloseTextDocumentParams) {
        info!("did_close");

        let mut analyzer = self.analyzer.lock().await;
        analyzer
            .remove_source(
                &params
                    .text_document
                    .uri
                    .to_file_path()
                    .expect("Failed to convert URI to file path"),
            )
            .expect("Failed to remove source");
    }

    async fn goto_definition(
        &self,
        params: GotoDefinitionParams,
    ) -> Result<Option<GotoDefinitionResponse>> {
        info!("goto_definition: {:?}", params);

        let analyzer = self.analyzer.lock().await;
        let result = analyzer
            .goto_definition(
                &params
                    .text_document_position_params
                    .text_document
                    .uri
                    .to_file_path()
                    .expect("Failed to convert URI to file path"),
                position_from_lsp(params.text_document_position_params.position),
            )
            .expect("Failed to find definition");

        Ok(result.map(|r| {
            GotoDefinitionResponse::Link(vec![LocationLink {
                origin_selection_range: Some(range_to_lsp(r.source_range)),
                target_uri: Url::from_file_path(&r.file)
                    .expect("Failed to convert file path to URI"),
                target_range: range_to_lsp(r.target_range),
                target_selection_range: range_to_lsp(r.target_selection_range),
            }])
        }))
    }

    async fn shutdown(&self) -> Result<()> {
        Ok(())
    }
}

#[tokio::main]
async fn main() {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();

    let (service, socket) = LspService::new(Backend::new);
    Server::new(stdin, stdout, socket).serve(service).await;
}
