import { z } from 'zod';
export const registryHostSchema = z.string().min(1).max(253).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?$/)
  .refine(host => !host.includes('..') && (!host.includes(':') || Number(host.split(':')[1]) <= 65535));
export const registryConfigurationSchema = z.object({ registryHost: registryHostSchema, username: z.string().max(200).optional(), password: z.string().max(4096).optional() }).strict()
  .refine(value => Boolean(value.username) === Boolean(value.password));
