import type { Bridge } from '../bridge';
import type { EdaApiOptions } from 'eda-copilot-backend/types';
import { currentTarget } from '../operations/cancellation';

/** Resolve once per operation; callers explicitly pass these options to the backend. */
export async function getEdaApiOptions(bridge: Bridge): Promise<EdaApiOptions> {
    const instanceId = currentTarget()?.instanceId ?? bridge.getSelectedEasyEdaInstanceId?.();
    const instances = await bridge.listEasyEdaInstances();
    const instance = instanceId ? instances.find(item => item.instanceId === instanceId)
        : instances.length === 1 ? instances[0] : undefined;
    if (instanceId && !instance) throw new Error('The selected EasyEDA instance is disconnected.');
    if (!instanceId && instances.length > 1) throw new Error('Select one EasyEDA instance before resolving components.');
    return { edaEdition: instance?.edaEdition ?? 'easyeda' };
}
