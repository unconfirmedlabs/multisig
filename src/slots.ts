export const PIV_SLOTS = [
  { slot: '9a', name: 'Authentication' },
  { slot: '9c', name: 'Digital signature' },
  { slot: '9d', name: 'Key management' },
  { slot: '9e', name: 'Card authentication' },
  ...Array.from({ length: 20 }, (_, i) => ({
    slot: (0x82 + i).toString(16),
    name: `Retired key ${i + 1}`,
  })),
] as const;

export const ALGORITHMS: Record<number, string> = {
  0x06: 'RSA-1024',
  0x07: 'RSA-2048',
  0x05: 'RSA-3072',
  0x16: 'RSA-4096',
  0x11: 'P-256',
  0x14: 'P-384',
  0xe0: 'Ed25519',
  0xe1: 'X25519',
};

export interface DeviceInfo {
  serial: number;
  firmware: string;
  reader: string;
}

export interface ScannedSlot {
  slot: string;
  name: string;
  state: 'empty' | 'occupied' | 'unknown';
  empty?: boolean;
  algorithm?: number;
  publicKeyHex?: string;
  pinPolicy?: number;
  touchPolicy?: number;
  origin?: number;
  certificatePresent?: boolean;
  error?: { code: string; message: string };
}

export interface DeviceSlots extends DeviceInfo {
  slots: ScannedSlot[];
}
