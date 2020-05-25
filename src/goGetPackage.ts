/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import cp = require('child_process');
import vscode = require('vscode');
import { buildCode } from './goBuild';
import { envPath } from './goPath';
import { outputChannel } from './goStatus';
import { getBinPath, getCurrentGoPath, getImportPath, getTimeoutConfiguration, killTree } from './util';

export function goGetPackage() {
	const editor = vscode.window.activeTextEditor;
	const selection = editor.selection;
	const selectedText = editor.document.lineAt(selection.active.line).text;

	const importPath = getImportPath(selectedText);
	if (importPath === '') {
		vscode.window.showErrorMessage('No import path to get');
		return;
	}

	const goRuntimePath = getBinPath('go');
	if (!goRuntimePath) {
		return vscode.window.showErrorMessage(
			`Failed to run "go get" to get package as the "go" binary cannot be found in either GOROOT(${process.env['GOROOT']}) or PATH(${envPath})`
		);
	}

	const env = Object.assign({}, process.env, { GOPATH: getCurrentGoPath() });

	const p = cp.execFile(goRuntimePath, ['get', '-v', importPath], { env }, (err, stdout, stderr) => {
		clearTimeout(processTimeout);
		// go get -v uses stderr to write output regardless of success or failure
		if (stderr !== '') {
			outputChannel.show();
			outputChannel.clear();
			outputChannel.appendLine(stderr);
			buildCode();
			return;
		}

		// go get -v doesn't write anything when the package already exists
		vscode.window.showInformationMessage(`Package already exists: ${importPath}`);
	});
	const processTimeout = setTimeout(() => {
		killTree(p.pid);
		vscode.window.showErrorMessage('Timeout executing "go get" to get the package');
	}, getTimeoutConfiguration('onCommand'));
}
