import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const context=vm.createContext({});
vm.runInContext(await readFile(new URL('../public/ambient-background.js',import.meta.url),'utf8'),context);
const ambient=context.HigherAmbient;
const padding=['I keep walking on the road to somewhere unknown','And every memory returns to me again','There is a place where I can rest my heart'];
test('封面雾色可独立生成',()=>{assert.match(ambient.mist(['#334455','#554433']),/radial-gradient/);assert.equal(ambient.classify,undefined);});
