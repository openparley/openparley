import type { LocalStore } from './local';
import type { SyncStore } from './sync';

export type OverlayStore = LocalStore | SyncStore;
export type { StoreState, StoreStatus } from './base';
