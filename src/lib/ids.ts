import { createId } from '@paralleldrive/cuid2';

/**
 * New id for a record, folder or image: a cuid2 (24 lowercase letters and digits, starts
 * with a letter). Ids made before the switch are UUIDs and stay as they are; nothing may
 * assume either format (ids are opaque strings).
 */
export const newId = (): string => createId();
