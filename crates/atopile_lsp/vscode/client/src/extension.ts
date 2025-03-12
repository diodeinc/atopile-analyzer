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

export function activate(context: ExtensionContext) {
  const outputChannel: OutputChannel =
    Window.createOutputChannel("atopile analyzer");

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
