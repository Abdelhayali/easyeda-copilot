import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bridge, EasyEdaInstance } from '../src/bridge';
import { getEdaApiOptions } from '../src/utils/eda-api-options';
import { withTarget } from '../src/operations/cancellation';

test('API options default to international and follow the selected or pinned instance', async () => {
    const instances = [
        { instanceId: 'en', edaEdition: 'easyeda' },
        { instanceId: 'cn', edaEdition: 'jlceda' },
    ] as EasyEdaInstance[];
    let selected: string | undefined;
    const bridge = {
        listEasyEdaInstances: async () => instances,
        getSelectedEasyEdaInstanceId: () => selected,
    } as Bridge;
    await assert.rejects(getEdaApiOptions(bridge), /Select one/);
    selected = 'en';
    assert.deepEqual(await getEdaApiOptions(bridge), { edaEdition: 'easyeda' });
    selected = 'cn';
    assert.deepEqual(await getEdaApiOptions(bridge), { edaEdition: 'jlceda' });
    assert.deepEqual(await withTarget({ instanceId: 'en' }, () => getEdaApiOptions(bridge)), { edaEdition: 'easyeda' });
    selected = 'missing';
    await assert.rejects(getEdaApiOptions(bridge), /disconnected/);
    selected = undefined;
    instances.splice(0, instances.length, { instanceId: 'legacy' } as EasyEdaInstance);
    assert.deepEqual(await getEdaApiOptions(bridge), { edaEdition: 'easyeda' });
    instances.length = 0;
    assert.deepEqual(await getEdaApiOptions(bridge), { edaEdition: 'easyeda' });
});
