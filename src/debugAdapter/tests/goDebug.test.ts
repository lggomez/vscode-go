/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'assert';
import tsup = require('vscode-debugadapter-testsupport');
//import {GoDebugSession} from '../goDebug';

let dc: tsup.DebugClient;

setup( () => {
    dc = new tsup.DebugClient('go', '../goDebug.js', 'go');
    return dc.start();
});

teardown( () => dc.stop() );

test('should run program to the end', () => {
    return Promise.all([
        dc.configurationSequence(),
        dc.launch({ program: 'main.go' }),
        dc.waitForEvent('terminated')
    ]);
});

test('should stop on entry', () => {
    return Promise.all([
        dc.configurationSequence(),
        dc.launch({ program: 'main.go', stopOnEntry: true }),
        dc.assertStoppedLocation('entry', {
			path: '',
			line: 1,
			column: 0,
		})
    ]);
});

test('should stop on a breakpoint', () => {
    return dc.hitBreakpoint({ program: 'main.go' }, {
		path: '',
		line: 1,
		column: 0,
		verified: false,
	}, {
		path: '',
		line: 1,
		column: 0,
		verified: false,
	});
});
