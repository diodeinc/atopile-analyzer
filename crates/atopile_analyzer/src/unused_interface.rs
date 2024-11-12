use std::{collections::HashSet, path::PathBuf};

use anyhow::Result;
use atopile_parser::parser::Connectable;

use crate::{
    AnalyzerDiagnostic, AnalyzerDiagnosticKind, AnalyzerDiagnosticSeverity, AtopileAnalyzer,
    UnconnectedInterfaceDiagnostic,
};

impl AtopileAnalyzer {
    /// Check for unused interfaces in the given source file. This performs the following steps:
    /// 1. Traverse all of the blocks in the source file.
    /// 2. For each block `B`, find all of the new assignments of the form `m = new Module`.
    /// 3. For each module assignment, look up the module and see which interfaces it defines.
    /// 4. Traverse the connections in `B` and look for a connection to each interface in `m`.
    /// 5. Report a diagnostic for any connections that were not found.
    pub(crate) fn analyze_unused_interfaces(
        &self,
        path: &PathBuf,
    ) -> Result<Vec<AnalyzerDiagnostic>> {
        let source = self.load_source(path)?;

        let mut diagnostics = vec![];

        // 1. Traverse all of the blocks in the source file.
        for module in source.modules.values() {
            // Pre-compute a set of all connections that have at least two components (i.e. `x.y`).
            // There must be at least 2 components if we're connecting to an interface, and if
            // the connection is further specified (e.g. `x.y.z`), we'll still count it.
            let connections = module
                .connections
                .iter()
                .flat_map(|c| [c.left.clone(), c.right.clone()].into_iter())
                .filter_map(|c| match c {
                    Connectable::Port(port) => Some(port),
                    _ => None,
                })
                .filter_map(|p| match (p.parts.get(0), p.parts.get(1)) {
                    (Some(p1), Some(p2)) => Some((p1.to_string(), p2.to_string())),
                    _ => None,
                })
                .collect::<HashSet<_>>();

            // 2. For each block, find all of the new assignments of the form `m = new Module`.
            for instantiation in module.instantiations.values() {
                // 3. For each module assignment, look up the module and see
                //    which interfaces it defines.
                let interfaces = instantiation.module.interfaces.values().collect::<Vec<_>>();
                for interface in interfaces {
                    // 4. Traverse the connections in `B` and look for a
                    //    connection to each interface in `m`.
                    let connection = connections
                        .get(&(instantiation.ident.to_string(), interface.ident.to_string()));

                    // 5. Report a diagnostic for any connections that were not found.
                    if connection.is_none() {
                        let unconnected_interface = UnconnectedInterfaceDiagnostic {
                            instance_name: instantiation.ident.to_string(),
                            interface_name: interface.ident.to_string(),
                            instantiation_location: instantiation.location.clone(),
                            interface_location: interface.location.clone(),
                        };

                        diagnostics.push(AnalyzerDiagnostic {
                            file: instantiation.location.file.clone(),
                            kind: AnalyzerDiagnosticKind::UnconnectedInterface(
                                unconnected_interface,
                            ),
                            severity: AnalyzerDiagnosticSeverity::Warning,
                        });
                    }
                }
            }
        }

        Ok(diagnostics)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use assert_fs::{prelude::*, TempDir};
    use insta::assert_snapshot;

    #[test]
    fn test_analyze_unused_interfaces() {
        let temp_dir = TempDir::new().unwrap();
        let temp_file = temp_dir.child("test.ato");
        temp_file
            .write_str(
                r#"
interface IF:
    pass

module MOD:
    if1 = new IF
    if2 = new IF

module P:
    a = new MOD

module M from P:
    b = new MOD

    b.if1 ~ a.if1
    "#,
            )
            .unwrap();

        let analyzer = AtopileAnalyzer::new();
        let diagnostics = analyzer
            .analyze_unused_interfaces(&temp_file.path().to_path_buf())
            .unwrap();

        // Sort for deterministic snapshots.
        let mut sorted_diagnostics = diagnostics
            .iter()
            .map(|d| format!("{:#?}", d))
            .collect::<Vec<_>>();
        sorted_diagnostics.sort();

        insta::with_settings!({
                    filters => vec![
                        (regex::escape(&format!("{:#?}", temp_file.path().canonicalize().unwrap())).as_ref(), "[TEMP_FILE]")
                    ],
                    sort_maps => true,
                }, {
            assert_snapshot!(sorted_diagnostics.join("\n"), @r###"
            AnalyzerDiagnostic {
                severity: Warning,
                kind: UnconnectedInterface(
                    UnconnectedInterfaceDiagnostic {
                        instance_name: "a",
                        interface_name: "if1",
                        instantiation_location: Location {
                            file: [TEMP_FILE],
                            range: Range {
                                start: Position {
                                    line: 9,
                                    column: 4,
                                },
                                end: Position {
                                    line: 9,
                                    column: 15,
                                },
                            },
                        },
                        interface_location: Location {
                            file: [TEMP_FILE],
                            range: Range {
                                start: Position {
                                    line: 5,
                                    column: 4,
                                },
                                end: Position {
                                    line: 5,
                                    column: 16,
                                },
                            },
                        },
                    },
                ),
                file: [TEMP_FILE],
            }
            AnalyzerDiagnostic {
                severity: Warning,
                kind: UnconnectedInterface(
                    UnconnectedInterfaceDiagnostic {
                        instance_name: "a",
                        interface_name: "if2",
                        instantiation_location: Location {
                            file: [TEMP_FILE],
                            range: Range {
                                start: Position {
                                    line: 9,
                                    column: 4,
                                },
                                end: Position {
                                    line: 9,
                                    column: 15,
                                },
                            },
                        },
                        interface_location: Location {
                            file: [TEMP_FILE],
                            range: Range {
                                start: Position {
                                    line: 6,
                                    column: 4,
                                },
                                end: Position {
                                    line: 6,
                                    column: 16,
                                },
                            },
                        },
                    },
                ),
                file: [TEMP_FILE],
            }
            AnalyzerDiagnostic {
                severity: Warning,
                kind: UnconnectedInterface(
                    UnconnectedInterfaceDiagnostic {
                        instance_name: "a",
                        interface_name: "if2",
                        instantiation_location: Location {
                            file: [TEMP_FILE],
                            range: Range {
                                start: Position {
                                    line: 9,
                                    column: 4,
                                },
                                end: Position {
                                    line: 9,
                                    column: 15,
                                },
                            },
                        },
                        interface_location: Location {
                            file: [TEMP_FILE],
                            range: Range {
                                start: Position {
                                    line: 6,
                                    column: 4,
                                },
                                end: Position {
                                    line: 6,
                                    column: 16,
                                },
                            },
                        },
                    },
                ),
                file: [TEMP_FILE],
            }
            AnalyzerDiagnostic {
                severity: Warning,
                kind: UnconnectedInterface(
                    UnconnectedInterfaceDiagnostic {
                        instance_name: "b",
                        interface_name: "if2",
                        instantiation_location: Location {
                            file: [TEMP_FILE],
                            range: Range {
                                start: Position {
                                    line: 12,
                                    column: 4,
                                },
                                end: Position {
                                    line: 12,
                                    column: 15,
                                },
                            },
                        },
                        interface_location: Location {
                            file: [TEMP_FILE],
                            range: Range {
                                start: Position {
                                    line: 6,
                                    column: 4,
                                },
                                end: Position {
                                    line: 6,
                                    column: 16,
                                },
                            },
                        },
                    },
                ),
                file: [TEMP_FILE],
            }
            "###);
        });
    }
}
