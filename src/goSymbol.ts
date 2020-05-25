/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import cp = require('child_process');
import vscode = require('vscode');
import { promptForMissingTool, promptForUpdatingTool } from './goInstallTools';
import {
	getBinPath,
	getGoConfig,
	getTimeoutConfiguration,
	getToolsEnvVars,
	getWorkspaceFolderPath,
	killTree
} from './util';

// Keep in sync with github.com/acroca/go-symbols'
interface GoSymbolDeclaration {
	name: string;
	kind: string;
	package: string;
	path: string;
	line: number;
	character: number;
}

export class GoWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
	private goKindToCodeKind: { [key: string]: vscode.SymbolKind } = {
		package: vscode.SymbolKind.Package,
		import: vscode.SymbolKind.Namespace,
		var: vscode.SymbolKind.Variable,
		type: vscode.SymbolKind.Interface,
		func: vscode.SymbolKind.Function,
		const: vscode.SymbolKind.Constant
	};

	public provideWorkspaceSymbols(
		query: string,
		token: vscode.CancellationToken
	): Thenable<vscode.SymbolInformation[]> {
		const convertToCodeSymbols = (decls: GoSymbolDeclaration[], symbols: vscode.SymbolInformation[]): void => {
			if (!decls) {
				return;
			}
			for (const decl of decls) {
				let kind: vscode.SymbolKind;
				if (decl.kind !== '') {
					kind = this.goKindToCodeKind[decl.kind];
				}
				const pos = new vscode.Position(decl.line, decl.character);
				const symbolInfo = new vscode.SymbolInformation(
					decl.name,
					kind,
					new vscode.Range(pos, pos),
					vscode.Uri.file(decl.path),
					''
				);
				symbols.push(symbolInfo);
			}
		};
		const root = getWorkspaceFolderPath(
			vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri
		);
		const goConfig = getGoConfig();

		if (!root && !goConfig.gotoSymbol.includeGoroot) {
			vscode.window.showInformationMessage('No workspace is open to find symbols.');
			return;
		}

		return getWorkspaceSymbols(root, query, token, goConfig).then((results) => {
			const symbols: vscode.SymbolInformation[] = [];
			convertToCodeSymbols(results, symbols);
			return symbols;
		});
	}
}

export function getWorkspaceSymbols(
	workspacePath: string,
	query: string,
	token: vscode.CancellationToken,
	goConfig?: vscode.WorkspaceConfiguration,
	ignoreFolderFeatureOn: boolean = true
): Thenable<GoSymbolDeclaration[]> {
	if (!goConfig) {
		goConfig = getGoConfig();
	}
	const gotoSymbolConfig = goConfig['gotoSymbol'];
	const calls: Promise<GoSymbolDeclaration[]>[] = [];

	const ignoreFolders: string[] = gotoSymbolConfig ? gotoSymbolConfig['ignoreFolders'] : [];
	const baseArgs =
		ignoreFolderFeatureOn && ignoreFolders && ignoreFolders.length > 0 ? ['-ignore', ignoreFolders.join(',')] : [];

	calls.push(callGoSymbols([...baseArgs, workspacePath, query], token));

	if (gotoSymbolConfig.includeGoroot) {
		const goRoot = process.env['GOROOT'];
		const gorootCall = callGoSymbols([...baseArgs, goRoot, query], token);
		calls.push(gorootCall);
	}

	return Promise.all(calls)
		.then(([...results]) => <GoSymbolDeclaration[]>[].concat(...results))
		.catch((err: Error) => {
			if (err && (<any>err).code === 'ENOENT') {
				promptForMissingTool('go-symbols');
			}
			if (err.message.startsWith('flag provided but not defined: -ignore')) {
				promptForUpdatingTool('go-symbols');
				return getWorkspaceSymbols(workspacePath, query, token, goConfig, false);
			}
		});
}

function callGoSymbols(args: string[], token: vscode.CancellationToken): Promise<GoSymbolDeclaration[]> {
	const gosyms = getBinPath('go-symbols');
	let p: cp.ChildProcess;
	let processTimeout: NodeJS.Timeout;
	if (token) {
		token.onCancellationRequested(() => {
			clearTimeout(processTimeout);
			killTree(p.pid);
		});
	}

	// Set up execFile parameters
	const options: { [key: string]: any } = {
		env: getToolsEnvVars(),
		maxBuffer: 1024 * 1024
	};

	return new Promise((resolve, reject) => {
		p = cp.execFile(gosyms, args, options, (err, stdout, stderr) => {
			clearTimeout(processTimeout);
			if (err && stderr && stderr.startsWith('flag provided but not defined: -ignore')) {
				return reject(new Error(stderr));
			} else if (err) {
				return reject(err);
			}
			const result = stdout.toString();
			const decls = <GoSymbolDeclaration[]>JSON.parse(result);
			return resolve(decls);
		});
		processTimeout = setTimeout(() => {
			killTree(p.pid);
			reject(new Error('Timeout executing tool - go-symbols'));
		}, getTimeoutConfiguration('onCommand'));
	});
}
