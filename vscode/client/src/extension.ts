/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from "path";
import {
  workspace as Workspace,
  window as Window,
  ExtensionContext,
  TextDocument,
  OutputChannel,
  WorkspaceFolder,
  Uri,
  commands,
  WebviewPanel,
  ViewColumn,
  CustomTextEditorProvider,
  CancellationToken,
  CustomDocument,
  StatusBarAlignment,
} from "vscode";

import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

import * as cp from "child_process";

let defaultClient: LanguageClient;
const clients = new Map<string, LanguageClient>();

function buildClient(
  clientOptions: LanguageClientOptions,
  context: ExtensionContext
): LanguageClient {
  // Set up the language server
  const serverOptions: ServerOptions = {
    command: context.asAbsolutePath(path.join("lsp", "atopile_lsp")),
    args: [],
    transport: TransportKind.stdio,
    options: {
      env: { RUST_LOG: "info", RUST_BACKTRACE: "1" },
    },
  };

  let client = new LanguageClient(
    "diode.lsp",
    "atopile analyzer",
    serverOptions,
    clientOptions
  );

  client.start();

  return client;
}

let _sortedWorkspaceFolders: string[] | undefined;
function sortedWorkspaceFolders(): string[] {
  if (_sortedWorkspaceFolders === void 0) {
    _sortedWorkspaceFolders = Workspace.workspaceFolders
      ? Workspace.workspaceFolders
          .map((folder) => {
            let result = folder.uri.toString();
            if (result.charAt(result.length - 1) !== "/") {
              result = result + "/";
            }
            return result;
          })
          .sort((a, b) => {
            return a.length - b.length;
          })
      : [];
  }
  return _sortedWorkspaceFolders;
}
Workspace.onDidChangeWorkspaceFolders(
  () => (_sortedWorkspaceFolders = undefined)
);

function getOuterMostWorkspaceFolder(folder: WorkspaceFolder): WorkspaceFolder {
  const sorted = sortedWorkspaceFolders();
  for (const element of sorted) {
    let uri = folder.uri.toString();
    if (uri.charAt(uri.length - 1) !== "/") {
      uri = uri + "/";
    }
    if (uri.startsWith(element)) {
      return Workspace.getWorkspaceFolder(Uri.parse(element))!;
    }
  }
  return folder;
}

class AtoPreviewDocument implements CustomDocument {
  public readonly uri: Uri;

  constructor(uri: Uri) {
    this.uri = uri;
  }

  dispose(): void {}
}

class AtoPreviewProvider implements CustomTextEditorProvider {
  private static readonly viewType = "atopile.preview";
  private readonly context: ExtensionContext;

  constructor(context: ExtensionContext) {
    this.context = context;
  }

  private async getNetlist(document: TextDocument): Promise<any> {
    // Get the LSP client for this document
    const folder = Workspace.getWorkspaceFolder(document.uri);
    if (!folder) {
      throw new Error("Document not in workspace");
    }

    const client = clients.get(folder.uri.toString()) || defaultClient;
    if (!client) {
      throw new Error("No LSP client available");
    }

    // Execute the command
    const result = await client.sendRequest("atopile/getNetlist");

    if (!result) {
      throw new Error("Failed to get netlist from LSP server");
    }

    return result;
  }

  private async updatePreview(
    document: TextDocument,
    webviewPanel: WebviewPanel,
    selectedModule?: string
  ) {
    try {
      const netlist = await this.getNetlist(document);
      console.log("netlist", netlist);
      await webviewPanel.webview.postMessage({
        command: "update",
        netlist: netlist,
        currentFile: document.uri.fsPath,
        selectedModule: selectedModule,
      });
    } catch (error) {
      Window.showErrorMessage(`Failed to update preview: ${error}`);
    }
  }

  async resolveCustomTextEditor(
    document: TextDocument,
    webviewPanel: WebviewPanel,
    _token: CancellationToken,
    selectedModule?: string
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        Uri.file(path.join(this.context.extensionPath, "preview", "build")),
      ],
    };

    const previewHtmlPath = Uri.file(
      path.join(this.context.extensionPath, "preview", "build", "index.html")
    );

    const previewHtml = await Workspace.fs.readFile(previewHtmlPath);
    let htmlContent = new TextDecoder().decode(previewHtml);

    // Get the build directory URI that VS Code can use in the webview
    const buildDirUri = webviewPanel.webview.asWebviewUri(
      Uri.file(path.join(this.context.extensionPath, "preview", "build"))
    );

    // Replace all resource paths to use the webview URI scheme
    htmlContent = htmlContent
      // Replace base href
      .replace('<base href="/" />', `<base href="${buildDirUri}/" />`)
      // Replace absolute paths in script tags
      .replace(
        /(src|href)="\/([^"]*)"/g,
        (match, attr, path) => `${attr}="${buildDirUri}/${path}"`
      )
      // Replace relative paths in script tags
      .replace(
        /(src|href)="\.\/([^"]*)"/g,
        (match, attr, path) => `${attr}="${buildDirUri}/${path}"`
      )
      // Replace paths in manifest links
      .replace(
        /(manifest|icon|apple-touch-icon|shortcut icon)" href="([^"]*)"/g,
        (match, rel, path) => `${rel}" href="${buildDirUri}/${path}"`
      );

    webviewPanel.webview.html = htmlContent;

    // Set up message handlers
    webviewPanel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.command) {
          case "error":
            Window.showErrorMessage(message.text);
            return;
          case "ready":
            // When the webview signals it's ready, send the initial netlist
            this.updatePreview(document, webviewPanel, selectedModule);
            return;
        }
      },
      undefined,
      this.context.subscriptions
    );

    // Set up document change subscription
    const changeDocumentSubscription = Workspace.onDidChangeTextDocument(
      (e) => {
        if (e.document.uri.toString() === document.uri.toString()) {
          this.updatePreview(document, webviewPanel, selectedModule);
        }
      }
    );

    // Clean up the subscription when the webview is disposed
    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
    });
  }

  async openCustomDocument(
    uri: Uri,
    _openContext: { backupId?: string },
    _token: CancellationToken
  ): Promise<AtoPreviewDocument> {
    return new AtoPreviewDocument(uri);
  }
}

interface Instance {
  kind: "Module" | "Component" | "Interface" | "Port" | "Pin";
  type_ref?: string;
  reference_designator?: string;
  children?: Record<string, Instance>;
}

interface Netlist {
  instances: Record<string, Instance>;
}

export function activate(context: ExtensionContext) {
  const outputChannel: OutputChannel =
    Window.createOutputChannel("atopile analyzer");

  // Create status bar item
  const schematicButton = Window.createStatusBarItem(
    StatusBarAlignment.Right,
    100
  );
  schematicButton.text = "$(circuit-board) View Schematic";
  schematicButton.command = "atopile.openSchematic";
  schematicButton.tooltip = "Open schematic viewer";
  context.subscriptions.push(schematicButton);

  // Show/hide the button based on active editor
  function updateStatusBarVisibility() {
    const activeEditor = Window.activeTextEditor;
    if (activeEditor && activeEditor.document.languageId === "ato") {
      schematicButton.show();
    } else {
      schematicButton.hide();
    }
  }

  // Register event handlers for the status bar item visibility
  context.subscriptions.push(
    Window.onDidChangeActiveTextEditor(() => updateStatusBarVisibility())
  );

  // Initial visibility check
  updateStatusBarVisibility();

  // Register the preview provider
  context.subscriptions.push(
    Window.registerCustomEditorProvider(
      "atopile.preview",
      new AtoPreviewProvider(context)
    )
  );

  // Register the command to open preview
  context.subscriptions.push(
    commands.registerCommand("atopile.openSchematic", async () => {
      const activeEditor = Window.activeTextEditor;
      if (activeEditor && activeEditor.document.languageId === "ato") {
        const uri = activeEditor.document.uri;

        // Get the LSP client for this document
        const folder = Workspace.getWorkspaceFolder(uri);
        if (!folder) {
          Window.showErrorMessage("Document not in workspace");
          return;
        }

        const client = clients.get(folder.uri.toString()) || defaultClient;
        if (!client) {
          Window.showErrorMessage("No LSP client available");
          return;
        }

        // Get the netlist data
        const netlist = (await client.sendRequest(
          "atopile/getNetlist"
        )) as Netlist;
        if (!netlist) {
          Window.showErrorMessage("Failed to get netlist from LSP server");
          return;
        }

        // Find top-level modules by looking at instance IDs
        const topLevelModules = Object.keys(netlist.instances).filter((id) => {
          // Top-level modules won't have a path after the module name
          const [file, instance_path] = id.split(":");
          if (instance_path.includes(".")) {
            return false;
          }

          return file === activeEditor.document.uri.fsPath;
        });

        let selectedModule: string;
        if (topLevelModules.length === 0) {
          Window.showErrorMessage("No top-level modules found in this file");
          return;
        } else if (topLevelModules.length === 1) {
          selectedModule = topLevelModules[0];
        } else {
          // Show quickpick to select module
          const selected = await Window.showQuickPick(
            topLevelModules.map((module) => ({
              label: module.split(":")[1],
              id: module,
            })),
            {
              placeHolder: "Select a module to view",
            }
          );
          if (!selected) {
            return; // User cancelled
          }
          selectedModule = selected.id;
        }

        // Create and show panel
        const panel = Window.createWebviewPanel(
          "atopile.preview",
          "Schematic Preview",
          ViewColumn.Beside,
          {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
              Uri.file(path.join(context.extensionPath, "preview", "build")),
            ],
          }
        );

        // Get the preview provider instance
        const provider = new AtoPreviewProvider(context);

        // Initialize the webview content
        await provider.resolveCustomTextEditor(
          activeEditor.document,
          panel,
          undefined,
          selectedModule
        );
      } else {
        Window.showErrorMessage("Please open an .ato file first");
      }
    })
  );

  // TODO: Re-enable
  // // Add file system watcher for pcb.toml files
  // const pcbTomlWatcher =
  //   Workspace.createFileSystemWatcher("**/[!.]**/pcb.toml");

  // // Function to run pcb build
  // async function runPcbBuild(uri: Uri) {
  //   try {
  //     const folderPath = path.dirname(uri.fsPath);
  //     outputChannel.appendLine(
  //       `Running pcb build for changes in ${uri.fsPath}`
  //     );

  //     // Execute pcb build command
  //     const result = cp.execSync("/Users/lenny/.diode/bin/pcb build", {
  //       cwd: folderPath,
  //       encoding: "utf-8",
  //     });

  //     outputChannel.appendLine(`pcb build output: ${result}`);
  //     Window.showInformationMessage(
  //       `PCB build completed for ${path.basename(folderPath)}`
  //     );
  //   } catch (error) {
  //     outputChannel.appendLine(`Error running pcb build: ${error}`);
  //     Window.showErrorMessage(`Failed to run pcb build: ${error}`);
  //   }
  // }

  // // Register event listeners for file changes
  // pcbTomlWatcher.onDidChange((uri) => {
  //   outputChannel.appendLine(`pcb.toml changed: ${uri.fsPath}`);
  //   runPcbBuild(uri);
  // });

  // // Add disposables to context
  // context.subscriptions.push(pcbTomlWatcher);

  function didOpenTextDocument(document: TextDocument): void {
    // We are only interested in language mode text
    if (
      document.languageId !== "ato" ||
      (document.uri.scheme !== "file" && document.uri.scheme !== "untitled")
    ) {
      return;
    }

    outputChannel.appendLine(`opening document ${document.uri.toString()}`);

    const uri = document.uri;
    // Untitled files go to a default client.
    if (uri.scheme === "untitled" && !defaultClient) {
      const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: "file", language: "ato" }],
        synchronize: {
          fileEvents: Workspace.createFileSystemWatcher("**/*.{ato}"),
        },
        outputChannel: outputChannel,
      };
      defaultClient = buildClient(clientOptions, context);
      return;
    }
    let folder = Workspace.getWorkspaceFolder(uri);
    // Files outside a folder can't be handled. This might depend on the language.
    // Single file languages like JSON might handle files outside the workspace folders.
    if (!folder) {
      return;
    }
    // If we have nested workspace folders we only start a server on the outer most workspace folder.
    folder = getOuterMostWorkspaceFolder(folder);

    if (!clients.has(folder.uri.toString())) {
      const clientOptions: LanguageClientOptions = {
        documentSelector: [
          {
            scheme: "file",
            language: "ato",
            pattern: `${folder.uri.fsPath}/**/*`,
          },
        ],
        workspaceFolder: folder,
        outputChannel: outputChannel,
      };
      const client = buildClient(clientOptions, context);
      clients.set(folder.uri.toString(), client);
    }
  }

  Workspace.onDidOpenTextDocument(didOpenTextDocument);
  Workspace.textDocuments.forEach(didOpenTextDocument);
  Workspace.onDidChangeWorkspaceFolders((event) => {
    for (const folder of event.removed) {
      const client = clients.get(folder.uri.toString());
      if (client) {
        clients.delete(folder.uri.toString());
        client.stop();
      }
    }
  });
}

export function deactivate(): Thenable<void> {
  const promises: Thenable<void>[] = [];
  if (defaultClient) {
    promises.push(defaultClient.stop());
  }
  for (const client of clients.values()) {
    promises.push(client.stop());
  }
  return Promise.all(promises).then(() => undefined);
}
