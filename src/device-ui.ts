import type { DeviceInfo, DeviceSlots, ScannedSlot } from './slots.ts';
import { ALGORITHMS } from './slots.ts';
import { keyReference, type Hardware } from './hardware.ts';
import { Terminal, terminalText } from './terminal.ts';
import { assert } from './errors.ts';

export interface SlotSummary extends ScannedSlot {
  algorithmName: string | null;
  suiAddress: string | null;
  keyId: string | null;
}
export interface SlotOverview extends DeviceInfo {
  slots: SlotSummary[];
}

export function summarizeSlots(data: DeviceSlots): SlotOverview {
  return {
    ...data,
    slots: data.slots.map((slot) => {
      let suiAddress: string | null = null;
      if (slot.state === 'occupied' && slot.algorithm === 0x11 && slot.publicKeyHex) {
        try {
          suiAddress = keyReference({ ...slot, serial: data.serial }).address;
        } catch {
          /* Occupied malformed keys remain visible, without an address. */
        }
      }
      return {
        ...slot,
        algorithmName:
          slot.algorithm === undefined
            ? null
            : (ALGORITHMS[slot.algorithm] ?? `Unknown (${slot.algorithm})`),
        suiAddress,
        keyId: suiAddress ? `${data.serial}_${slot.slot}` : null,
      };
    }),
  };
}

export function slotTable(data: SlotOverview): string {
  const lines = [
    `YubiKey ${data.serial} · firmware ${terminalText(data.firmware)}`,
    '',
    `${'Slot'.padEnd(6)}${'Purpose'.padEnd(23)}${'State'.padEnd(12)}${'Algorithm'.padEnd(14)}Sui address`,
  ];
  for (const slot of data.slots) {
    const short = slot.suiAddress
      ? `${slot.suiAddress.slice(0, 10)}…${slot.suiAddress.slice(-8)}`
      : '—';
    lines.push(
      `${slot.slot.toUpperCase().padEnd(6)}${terminalText(slot.name).padEnd(23)}${slot.state.padEnd(12)}${(slot.algorithmName ?? '—').padEnd(14)}${short}`,
    );
  }
  lines.push('', '9B (management) and F9 (attestation) are reserved and are not listed.');
  if (data.slots.some((s) => s.state === 'unknown'))
    lines.push('Unknown slots could not be inspected; they are not treated as empty.');
  return lines.join('\n') + '\n';
}

export async function selectDevice(
  hardware: typeof Hardware.Service,
  terminal: Terminal,
): Promise<DeviceInfo> {
  terminal.write('Looking for connected YubiKeys…\n');
  const { devices } = (await hardware.call({ op: 'devices' })) as { devices: DeviceInfo[] };
  assert(devices.length > 0, 'DEVICE_NOT_FOUND', 'No YubiKey with PIV enabled is connected.');
  if (devices.length === 1) {
    terminal.write(
      `Using YubiKey ${devices[0]!.serial} (firmware ${terminalText(devices[0]!.firmware)}).\n`,
    );
    return devices[0]!;
  }
  return terminal.choose(
    'Choose a YubiKey',
    devices.map((device) => ({
      label: `YubiKey ${device.serial} · firmware ${device.firmware} · ${device.reader}`,
      value: device,
    })),
  );
}

export async function getSlots(
  hardware: typeof Hardware.Service,
  serial: number,
): Promise<SlotOverview> {
  return summarizeSlots((await hardware.call({ op: 'slots', serial })) as DeviceSlots);
}

export async function pickAddress(
  hardware: typeof Hardware.Service,
  terminal: Terminal,
  serial?: number,
  slotId?: string,
) {
  const deviceSerial = serial ?? (await selectDevice(hardware, terminal)).serial;
  terminal.write('Reading PIV slot occupancy (no PIN or touch required)…\n');
  const data = await getSlots(hardware, deviceSerial);
  terminal.write('\n' + slotTable(data));
  const keys = data.slots.filter(
    (s) => s.suiAddress && (!slotId || s.slot === slotId.toLowerCase()),
  );
  assert(
    keys.length > 0,
    'NO_SUI_KEYS',
    slotId
      ? `Slot ${slotId} does not contain a readable P-256 key.`
      : 'No readable P-256 key was found on this YubiKey.',
  );
  const selected = slotId
    ? keys[0]!
    : await terminal.choose(
        'Choose a key to view its Sui address',
        keys.map((slot) => ({
          label: `${slot.slot.toUpperCase()} · ${slot.name} · ${slot.suiAddress}`,
          value: slot,
        })),
      );
  return { keyId: selected.keyId!, ...keyReference({ ...selected, serial: deviceSerial }) };
}
