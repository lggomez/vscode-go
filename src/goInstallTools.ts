/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import cp = require('child_process');
import fs = require('fs');
import path = require('path');
import { SemVer } from 'semver';
import vscode = require('vscode');
import { getLanguageServerToolPath } from './goLanguageServer';
import { restartLanguageServer } from './goMain';
import { envPath, getToolFromToolPath } from './goPath';
import { hideGoStatus, outputChannel, showGoStatus } from './goStatus';
import {
	containsString,
	containsTool,
	disableModulesForWildcard,
	getConfiguredTools,
	getImportPath,
	getImportPathWithVersion,
	getTool,
	hasModSuffix,
	isGocode,
	Tool,
	ToolAtVersion
} from './goTools';
import {
	getBinPath,
	getCurrentGoPath,
	getGoConfig,
	getGoVersion,
	getTempFilePath,
	getToolsEnvVars,
	getToolsGopath,
	GoVersion,
	resolvePath
} from './util';

// declinedUpdates tracks the tools that the user has declined to update.
const declinedUpdates: Tool[] = [];

// declinedUpdates tracks the tools that the user has declined to install.
const declinedInstalls: Tool[] = [];

export async function installAllTools(updateExistingToolsOnly: boolean = false) {
	const goVersion = await getGoVersion();
	let allTools = getConfiguredTools(goVersion);

	// exclude tools replaced by alternateTools.
	const alternateTools: { [key: string]: string } = getGoConfig().get('alternateTools');
	allTools = allTools.filter((tool) => {
		return !alternateTools[tool.name];
	});

	// Update existing tools by finding all tools the user has already installed.
	if (updateExistingToolsOnly) {
		await installTools(
			allTools.filter((tool) => {
				const toolPath = getBinPath(tool.name);
				return toolPath && path.isAbsolute(toolPath);
			}),
			goVersion
		);
		return;
	}

	// Otherwise, allow the user to select which tools to install or update.
	const selected = await vscode.window.showQuickPick(
		allTools.map((x) => {
			const item: vscode.QuickPickItem = {
				label: x.name,
				description: x.description
			};
			return item;
		}),
		{
			canPickMany: true,
			placeHolder: 'Select the tools to install/update.'
		}
	);
	if (!selected) {
		return;
	}
	await installTools(selected.map((x) => getTool(x.label)), goVersion);
}

/**
 * Installs given array of missing tools. If no input is given, the all tools are installed
 *
 * @param missing array of tool names and optionally, their versions to be installed.
 *                If a tool's version is not specified, it will install the latest.
 * @param goVersion version of Go that affects how to install the tool. (e.g. modules vs legacy GOPATH mode)
 */
export async function installTools(missing: ToolAtVersion[], goVersion: GoVersion): Promise<void> {
	const goRuntimePath = getBinPath('go');
	if (!goRuntimePath) {
		vscode.window.showErrorMessage(
			`Failed to run "go get" to install the packages as the "go" binary cannot be found in either GOROOT(${process.env['GOROOT']}) or PATH(${envPath})`
		);
		return;
	}
	if (!missing) {
		return;
	}

	// http.proxy setting takes precedence over environment variables
	const httpProxy = vscode.workspace.getConfiguration('http', null).get('proxy');
	const envForTools = Object.assign({}, process.env, getToolsEnvVars());
	if (httpProxy) {
		envForTools['http_proxy'] = httpProxy;
		envForTools['HTTP_PROXY'] = httpProxy;
		envForTools['https_proxy'] = httpProxy;
		envForTools['HTTPS_PROXY'] = httpProxy;
	}

	outputChannel.show();
	outputChannel.clear();

	// If the go.toolsGopath is set, use its value as the GOPATH for the "go get" child process.
	// Else use the Current Gopath
	let toolsGopath = getToolsGopath();
	if (toolsGopath) {
		// User has explicitly chosen to use toolsGopath, so ignore GOBIN
		envForTools['GOBIN'] = '';
		outputChannel.appendLine(`Using the value ${toolsGopath} from the go.toolsGopath setting.`);
	} else {
		toolsGopath = getCurrentGoPath();
		outputChannel.appendLine(`go.toolsGopath setting is not set. Using GOPATH ${toolsGopath}`);
	}
	if (toolsGopath) {
		const paths = toolsGopath.split(path.delimiter);
		toolsGopath = paths[0];
		envForTools['GOPATH'] = toolsGopath;
	} else {
		const msg = 'Cannot install Go tools. Set either go.gopath or go.toolsGopath in settings.';
		vscode.window.showInformationMessage(msg, 'Open User Settings', 'Open Workspace Settings').then((selected) => {
			switch (selected) {
				case 'Open User Settings':
					vscode.commands.executeCommand('workbench.action.openGlobalSettings');
					break;
				case 'Open Workspace Settings':
					vscode.commands.executeCommand('workbench.action.openWorkspaceSettings');
					break;
			}
		});
		return;
	}

	let installingMsg = `Installing ${missing.length} ${missing.length > 1 ? 'tools' : 'tool'} at `;
	if (envForTools['GOBIN']) {
		installingMsg += `the configured GOBIN: ${envForTools['GOBIN']}`;
	} else {
		installingMsg += toolsGopath + path.sep + 'bin';
	}

	// If the user is on Go >= 1.11, tools should be installed with modules enabled.
	// This ensures that users get the latest tagged version, rather than master,
	// which may be unstable.
	let modulesOff = false;
	if (goVersion.lt('1.11')) {
		modulesOff = true;
	} else {
		installingMsg += ' in module mode.';
	}

	outputChannel.appendLine(installingMsg);
	missing.forEach((missingTool) => {
		let toolName = missingTool.name;
		if (missingTool.version) {
			toolName += '@' + missingTool.version;
		}
		outputChannel.appendLine('  ' + toolName);
	});

	outputChannel.appendLine(''); // Blank line for spacing.

	// Install tools in a temporary directory, to avoid altering go.mod files.
	const toolsTmpDir = fs.mkdtempSync(getTempFilePath('go-tools-'));

	return missing
		.reduce((res: Promise<string[]>, tool: ToolAtVersion) => {
			return res.then(
				(sofar) =>
					new Promise<string[]>(async (resolve, reject) => {
						// Disable modules for tools which are installed with the "..." wildcard.
						// TODO: ... will be supported in Go 1.13, so enable these tools to use modules then.
						const modulesOffForTool = modulesOff || disableModulesForWildcard(tool, goVersion);
						let tmpGoModFile: string;
						if (modulesOffForTool) {
							envForTools['GO111MODULE'] = 'off';
						} else {
							envForTools['GO111MODULE'] = 'on';
							// Write a temporary go.mod file to avoid version conflicts.
							tmpGoModFile = path.join(toolsTmpDir, 'go.mod');
							fs.writeFileSync(tmpGoModFile, 'module tools');
						}
						let importPath: string;
						if (modulesOffForTool) {
							importPath = getImportPath(tool, goVersion);
						} else {
							importPath = getImportPathWithVersion(tool, tool.version, goVersion);
						}

						const callback = (err: Error, stdout: string, stderr: string) => {
							// Make sure to delete the temporary go.mod file, if it exists.
							if (tmpGoModFile && fs.existsSync(tmpGoModFile)) {
								fs.unlinkSync(tmpGoModFile);
							}
							if (err) {
								outputChannel.appendLine('Installing ' + importPath + ' FAILED');
								const failureReason = tool.name + ';;' + err + stdout.toString() + stderr.toString();
								resolve([...sofar, failureReason]);
							} else {
								outputChannel.appendLine('Installing ' + importPath + ' SUCCEEDED');
								resolve([...sofar, null]);
							}
						};

						// Perform any on-close actions before reinstalling the tool.
						if (tool.close) {
							const errMsg = await tool.close();
							if (errMsg) {
								outputChannel.appendLine(errMsg);
								resolve([...sofar, null]);
								return;
							}
						}
						const args = ['get', '-v'];
						// Only get tools at master if we are not using modules.
						if (modulesOffForTool) {
							args.push('-u');
						}
						// Tools with a "mod" suffix should not be installed,
						// instead we run "go build -o" to rename them.
						if (hasModSuffix(tool)) {
							args.push('-d');
						}
						args.push(importPath);
						const opts = {
							env: envForTools,
							cwd: toolsTmpDir
						};
						cp.execFile(goRuntimePath, args, opts, (err, stdout, stderr) => {
							if (stderr.indexOf('unexpected directory layout:') > -1) {
								outputChannel.appendLine(
									`Installing ${importPath} failed with error "unexpected directory layout". Retrying...`
								);
								cp.execFile(goRuntimePath, args, opts, callback);
							} else if (!err && hasModSuffix(tool)) {
								const outputFile = path.join(
									toolsGopath,
									'bin',
									process.platform === 'win32' ? `${tool.name}.exe` : tool.name
								);
								cp.execFile(
									goRuntimePath,
									['build', '-o', outputFile, getImportPath(tool, goVersion)],
									opts,
									callback
								);
							} else {
								callback(err, stdout, stderr);
							}
						});
					})
			);
		}, Promise.resolve([]))
		.then((res) => {
			outputChannel.appendLine(''); // Blank line for spacing
			const failures = res.filter((x) => x != null);
			if (failures.length === 0) {
				outputChannel.appendLine('All tools successfully installed. You are ready to Go :).');

				// Restart the language server since a new binary has been installed.
				if (containsString(missing, 'gopls')) {
					restartLanguageServer();
				}
				return;
			}

			outputChannel.appendLine(failures.length + ' tools failed to install.\n');
			failures.forEach((failure) => {
				const reason = failure.split(';;');
				outputChannel.appendLine(reason[0] + ':');
				outputChannel.appendLine(reason[1]);
			});
		});
}

export async function promptForMissingTool(toolName: string) {
	const tool = getTool(toolName);

	// If user has declined to install this tool, don't prompt for it.
	if (containsTool(declinedInstalls, tool)) {
		return;
	}

	const goVersion = await getGoVersion();

	// Show error messages for outdated tools or outdated Go versions.
	if (tool.minimumGoVersion && goVersion.lt(tool.minimumGoVersion.format())) {
		vscode.window.showInformationMessage(`You are using go${goVersion.format()}, but ${tool.name} requires at least go${tool.minimumGoVersion.format()}.`);
		return;
	}
	if (tool.maximumGoVersion && goVersion.gt(tool.maximumGoVersion.format())) {
		vscode.window.showInformationMessage(`You are using go${goVersion.format()}, but ${tool.name} only supports go${tool.maximumGoVersion.format()} and below.`);
		return;
	}

	const installOptions = ['Install'];
	let missing = await getMissingTools(goVersion);
	if (!containsTool(missing, tool)) {
		return;
	}
	missing = missing.filter((x) => x === tool || tool.isImportant);
	if (missing.length > 1) {
		// Offer the option to install all tools.
		installOptions.push('Install All');
	}
	const msg = `The "${tool.name}" command is not available.
Run "go get -v ${getImportPath(tool, goVersion)}" to install.`;
	const selected = await vscode.window.showInformationMessage(msg, ...installOptions);
	switch (selected) {
		case 'Install':
			await installTools([tool], goVersion);
			break;
		case 'Install All':
			await installTools(missing, goVersion);
			hideGoStatus();
			break;
		default:
			// The user has declined to install this tool.
			declinedInstalls.push(tool);
			break;
	}
}

export async function promptForUpdatingTool(toolName: string, newVersion?: SemVer) {
	const tool = getTool(toolName);
	const toolVersion = { ...tool, version: newVersion }; // ToolWithVersion

	// If user has declined to update, then don't prompt.
	if (containsTool(declinedUpdates, tool)) {
		return;
	}
	const goVersion = await getGoVersion();
	let updateMsg = `Your version of ${tool.name} appears to be out of date. Please update for an improved experience.`;
	const choices: string[] = ['Update'];
	if (toolName === `gopls`) {
		choices.push('Release Notes');
	}
	if (newVersion) {
		updateMsg = `A new version of ${tool.name} (v${newVersion}) is available. Please update for an improved experience.`;
	}
	const selected = await vscode.window.showInformationMessage(updateMsg, ...choices);
	switch (selected) {
		case 'Update':
			await installTools([toolVersion], goVersion);
			break;
		case 'Release Notes':
			vscode.commands.executeCommand(
				'vscode.open',
				vscode.Uri.parse('https://github.com/golang/go/issues/33030#issuecomment-510151934')
			);
			break;
		default:
			declinedUpdates.push(tool);
			break;
	}
}

export function updateGoPathGoRootFromConfig(): Promise<void> {
	const goroot = getGoConfig()['goroot'];
	if (goroot) {
		process.env['GOROOT'] = resolvePath(goroot);
	}

	if (process.env['GOPATH'] && process.env['GOROOT'] && process.env['GOPROXY']) {
		return Promise.resolve();
	}

	// If GOPATH is still not set, then use the one from `go env`
	const goRuntimePath = getBinPath('go');
	if (!goRuntimePath) {
		vscode.window.showErrorMessage(
			`Failed to run "go env" to find GOPATH as the "go" binary cannot be found in either GOROOT(${process.env['GOROOT']}) or PATH(${envPath})`
		);
		return;
	}
	const goRuntimeBasePath = path.dirname(goRuntimePath);

	// cgo and a few other Go tools expect Go binary to be in the path
	let pathEnvVar: string;
	if (process.env.hasOwnProperty('PATH')) {
		pathEnvVar = 'PATH';
	} else if (process.platform === 'win32' && process.env.hasOwnProperty('Path')) {
		pathEnvVar = 'Path';
	}
	if (
		goRuntimeBasePath &&
		pathEnvVar &&
		process.env[pathEnvVar] &&
		(<string>process.env[pathEnvVar]).split(path.delimiter).indexOf(goRuntimeBasePath) === -1
	) {
		// Place the goRuntimeBasePath to the front so tools use the same version of go.
		process.env[pathEnvVar] = goRuntimeBasePath + path.delimiter + process.env[pathEnvVar];
	}

	return new Promise<void>((resolve, reject) => {
		cp.execFile(goRuntimePath, ['env', 'GOPATH', 'GOROOT', 'GOPROXY'], (err, stdout, stderr) => {
			if (err) {
				return reject();
			}
			const envOutput = stdout.split('\n');
			if (!process.env['GOPATH'] && envOutput[0].trim()) {
				process.env['GOPATH'] = envOutput[0].trim();
			}
			if (!process.env['GOROOT'] && envOutput[1] && envOutput[1].trim()) {
				process.env['GOROOT'] = envOutput[1].trim();
			}
			if (!process.env['GOPROXY'] && envOutput[2] && envOutput[2].trim()) {
				process.env['GOPROXY'] = envOutput[2].trim();
			}
			return resolve();
		});
	});
}

let alreadyOfferedToInstallTools = false;

export async function offerToInstallTools() {
	if (alreadyOfferedToInstallTools) {
		return;
	}
	alreadyOfferedToInstallTools = true;

	const goVersion = await getGoVersion();
	let missing = await getMissingTools(goVersion);
	missing = missing.filter((x) => x.isImportant);
	if (missing.length > 0) {
		showGoStatus('Analysis Tools Missing', 'go.promptforinstall', 'Not all Go tools are available on the GOPATH');
		vscode.commands.registerCommand('go.promptforinstall', () => {
			const installItem = {
				title: 'Install',
				async command() {
					hideGoStatus();
					await installTools(missing, goVersion);
				}
			};
			const showItem = {
				title: 'Show',
				command() {
					outputChannel.clear();
					outputChannel.appendLine('Below tools are needed for the basic features of the Go extension.');
					missing.forEach((x) => outputChannel.appendLine(x.name));
				}
			};
			vscode.window
				.showInformationMessage(
					'Failed to find some of the Go analysis tools. Would you like to install them?',
					installItem,
					showItem
				)
				.then((selection) => {
					if (selection) {
						selection.command();
					} else {
						hideGoStatus();
					}
				});
		});
	}

	const usingSourceGraph = getToolFromToolPath(getLanguageServerToolPath()) === 'go-langserver';
	if (usingSourceGraph && goVersion.gt('1.10')) {
		const promptMsg =
			'The language server from Sourcegraph is no longer under active development and it does not support Go modules as well. Please install and use the language server from Google or disable the use of language servers altogether.';
		const disableLabel = 'Disable language server';
		const installLabel = 'Install';
		const selected = await vscode.window.showInformationMessage(promptMsg, installLabel, disableLabel);
		if (selected === installLabel) {
			await installTools([getTool('gopls')], goVersion);
		} else if (selected === disableLabel) {
			const goConfig = getGoConfig();
			const inspectLanguageServerSetting = goConfig.inspect('useLanguageServer');
			if (inspectLanguageServerSetting.globalValue === true) {
				goConfig.update('useLanguageServer', false, vscode.ConfigurationTarget.Global);
			} else if (inspectLanguageServerSetting.workspaceFolderValue === true) {
				goConfig.update('useLanguageServer', false, vscode.ConfigurationTarget.WorkspaceFolder);
			}
		}
	}
}

function getMissingTools(goVersion: GoVersion): Promise<Tool[]> {
	const keys = getConfiguredTools(goVersion);
	return Promise.all<Tool>(
		keys.map(
			(tool) =>
				new Promise<Tool>((resolve, reject) => {
					const toolPath = getBinPath(tool.name);
					resolve(path.isAbsolute(toolPath) ? null : tool);
				})
		)
	).then((res) => {
		return res.filter((x) => x != null);
	});
}
