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
	dc.defaultTimeout = 20000;
    return dc.start();
});

teardown( () => dc.stop() );

test('should run program to the end', () => {
    return Promise.all([
        dc.configurationSequence(),
        dc.launch({ program: 'main/main.go' }),
        dc.waitForEvent('terminated')
    ]);
});

// test('should stop on entry', () => {
//     return Promise.all([
//         dc.configurationSequence(),
//         dc.launch({ program: 'main/main.go', stopOnEntry: true }),
//         dc.assertStoppedLocation('entry', {
// 			path: 'main.go',
// 			line: 12,
// 			column: 0,
// 		})
//     ]);
// });

// test('should stop on a breakpoint', () => {
//     return dc.hitBreakpoint({ program: 'main/main.go' }, {
// 		path: 'main.go',
// 		line: 12,
// 		column: 0,
// 		verified: false,
// 	}, {
// 		path: 'main.go',
// 		line: 12,
// 		column: 0,
// 		verified: false,
// 	});
// });
