/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'assert';
import tsup = require('vscode-debugadapter-testsupport');
import * as Path from 'path';
//import {GoDebugSession} from '../goDebug';

suite('Go Debug Adapter', () => {
	let dc: tsup.DebugClient;

	const PROJECT_ROOT = Path.join(__dirname, '../../../..');
	const DATA_ROOT = Path.join(PROJECT_ROOT, 'test/fixtures/debug');
	const PROJECT_OUTPUT = Path.join(__dirname, '../..');
	const DEBUG_ADAPTER = Path.join(PROJECT_OUTPUT, 'debugAdapter/goDebug.js');

	setup( () => {
		console.log('setup start');
		dc = new tsup.DebugClient('go', DEBUG_ADAPTER, 'go', undefined, true);
		dc.defaultTimeout = 20000;
		let p = dc.start();
		console.log('setup end');
		return p;
	});

	teardown( () => {
		console.log('teardown');
		dc.stop();
	} );

	suite('basic', () => {
		test('unknown request should produce error', done => {
			const err = new Error('does not report error on unknown request');
			console.log('basic dc.send');
			let r = dc.send('illegal_request');
			
			r.then(() => {
				console.log('basic dc.then');
				done(err);
			}).catch(() => {
				console.log('basic dc.catch');
				done();
			}).finally(() => {
				console.log('basic dc.finally');
				done(err);
			});

			console.log('basic end');
		});
	});

	suite('launch', () => {
		test('should run program to the end', () => {
			const PROGRAM = Path.join(DATA_ROOT, 'main/main.go');
			return Promise.all([
				dc.configurationSequence(),
				dc.launch({ program: PROGRAM }),
				dc.waitForEvent('terminated')
			]);
		});
	});
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
