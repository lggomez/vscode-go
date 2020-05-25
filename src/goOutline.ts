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
	getFileArchive,
	getGoConfig,
	getTimeoutConfiguration,
	getToolsEnvVars,
	killTree,
	makeMemoizedByteOffsetConverter
} from './util';

// Keep in sync with https://github.com/ramya-rao-a/go-outline
export interface GoOutlineRange {
	start: number;
	end: number;
}

export interface GoOutlineDeclaration {
	label: string;
	type: string;
	receiverType?: string;
	icon?: string; // icon class or null to use the default images based on the type
	start: number;
	end: number;
	children?: GoOutlineDeclaration[];
	signature?: GoOutlineRange;
	comment?: GoOutlineRange;
}

export enum GoOutlineImportsOptions {
	Include,
	Exclude,
	Only
}

export interface GoOutlineOptions {
	/**
	 * Path of the file for which outline is needed
	 */
	fileName: string;

	/**
	 * Option to decide if the output includes, excludes or only includes imports
	 * If the option is to only include imports, then the file will be parsed only till imports are collected
	 */
	importsOption: GoOutlineImportsOptions;

	/**
	 * Document to be parsed. If not provided, saved contents of the given fileName is used
	 */
	document?: vscode.TextDocument;
}

export async function documentSymbols(
	options: GoOutlineOptions,
	token: vscode.CancellationToken
): Promise<vscode.DocumentSymbol[]> {
	const decls = await runGoOutline(options, token);
	return convertToCodeSymbols(
		options.document,
		decls,
		options.importsOption !== GoOutlineImportsOptions.Exclude,
		makeMemoizedByteOffsetConverter(Buffer.from(options.document.getText()))
	);
}

export function runGoOutline(
	options: GoOutlineOptions,
	token: vscode.CancellationToken
): Promise<GoOutlineDeclaration[]> {
	return new Promise<GoOutlineDeclaration[]>((resolve, reject) => {
		const gooutline = getBinPath('go-outline');
		const gooutlineFlags = ['-f', options.fileName];
		if (options.importsOption === GoOutlineImportsOptions.Only) {
			gooutlineFlags.push('-imports-only');
		}
		if (options.document) {
			gooutlineFlags.push('-modified');
		}

		let p: cp.ChildProcess;
		let processTimout: NodeJS.Timer;
		if (token) {
			token.onCancellationRequested(() => {
				clearTimeout(processTimout);
				killTree(p.pid);
			});
		}

		// Spawn `go-outline` process
		p = cp.execFile(gooutline, gooutlineFlags, { env: getToolsEnvVars() }, (err, stdout, stderr) => {
			clearTimeout(processTimout);
			try {
				if (err && (<any>err).code === 'ENOENT') {
					promptForMissingTool('go-outline');
				}
				if (stderr && stderr.startsWith('flag provided but not defined: ')) {
					promptForUpdatingTool('go-outline');
					if (stderr.startsWith('flag provided but not defined: -imports-only')) {
						options.importsOption = GoOutlineImportsOptions.Include;
					}
					if (stderr.startsWith('flag provided but not defined: -modified')) {
						options.document = null;
					}
					p = null;
					return runGoOutline(options, token).then((results) => {
						return resolve(results);
					});
				}
				if (err) {
					return resolve(null);
				}
				const result = stdout.toString();
				const decls = <GoOutlineDeclaration[]>JSON.parse(result);
				return resolve(decls);
			} catch (e) {
				reject(e);
			}
		});
		if (options.document && p.pid) {
			p.stdin.end(getFileArchive(options.document));
		}
		processTimout = setTimeout(() => {
			killTree(p.pid);
			reject(new Error('Timeout executing tool - gooutline'));
		}, getTimeoutConfiguration('onCommand'));
	});
}

const goKindToCodeKind: { [key: string]: vscode.SymbolKind } = {
	package: vscode.SymbolKind.Package,
	import: vscode.SymbolKind.Namespace,
	variable: vscode.SymbolKind.Variable,
	constant: vscode.SymbolKind.Constant,
	type: vscode.SymbolKind.TypeParameter,
	function: vscode.SymbolKind.Function,
	struct: vscode.SymbolKind.Struct,
	interface: vscode.SymbolKind.Interface
};

function convertToCodeSymbols(
	document: vscode.TextDocument,
	decls: GoOutlineDeclaration[],
	includeImports: boolean,
	byteOffsetToDocumentOffset: (byteOffset: number) => number
): vscode.DocumentSymbol[] {
	const symbols: vscode.DocumentSymbol[] = [];
	(decls || []).forEach((decl) => {
		if (!includeImports && decl.type === 'import') {
			return;
		}
		if (decl.label === '_' && decl.type === 'variable') {
			return;
		}

		const label = decl.receiverType ? `(${decl.receiverType}).${decl.label}` : decl.label;

		const start = byteOffsetToDocumentOffset(decl.start - 1);
		const end = byteOffsetToDocumentOffset(decl.end - 1);
		const startPosition = document.positionAt(start);
		const endPosition = document.positionAt(end);
		const symbolRange = new vscode.Range(startPosition, endPosition);
		const selectionRange =
			startPosition.line === endPosition.line
				? symbolRange
				: new vscode.Range(startPosition, document.lineAt(startPosition.line).range.end);

		if (decl.type === 'type') {
			const line = document.lineAt(document.positionAt(start));
			const regexStruct = new RegExp(`^\\s*type\\s+${decl.label}\\s+struct\\b`);
			const regexInterface = new RegExp(`^\\s*type\\s+${decl.label}\\s+interface\\b`);
			decl.type = regexStruct.test(line.text) ? 'struct' : regexInterface.test(line.text) ? 'interface' : 'type';
		}

		const symbolInfo = new vscode.DocumentSymbol(
			label,
			decl.type,
			goKindToCodeKind[decl.type],
			symbolRange,
			selectionRange
		);

		symbols.push(symbolInfo);
		if (decl.children) {
			symbolInfo.children = convertToCodeSymbols(
				document,
				decl.children,
				includeImports,
				byteOffsetToDocumentOffset
			);
		}
	});
	return symbols;
}

export class GoDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
	constructor(private includeImports?: boolean) {}

	public provideDocumentSymbols(
		document: vscode.TextDocument,
		token: vscode.CancellationToken
	): Thenable<vscode.DocumentSymbol[]> {
		if (typeof this.includeImports !== 'boolean') {
			const gotoSymbolConfig = getGoConfig(document.uri)['gotoSymbol'];
			this.includeImports = gotoSymbolConfig ? gotoSymbolConfig['includeImports'] : false;
		}
		const options: GoOutlineOptions = {
			fileName: document.fileName,
			document,
			importsOption: this.includeImports ? GoOutlineImportsOptions.Include : GoOutlineImportsOptions.Exclude
		};
		return documentSymbols(options, token);
	}
}
