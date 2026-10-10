"use client";
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { z } from 'zod';
import { Input } from '@/components/ui/input';

export function RegistryConfigurationCard({ projectId, apiBaseUrl }: { projectId: string; apiBaseUrl: string | null }) {
  const [pending, setPending] = useState(false), [message, setMessage] = useState('');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    setPending(true); setMessage('');
    try {
      if (!apiBaseUrl) throw new Error('API unavailable');
      const registryHost = String(values.get('registryHost') ?? ''), username = String(values.get('username') ?? ''), password = String(values.get('password') ?? '');
      const payload = { registryHost, ...(username || password ? { username, password } : {}) };
      form.reset();
      const response = await fetch(new URL(`/api/v1/projects/${encodeURIComponent(projectId)}/registries`, apiBaseUrl), {
        method: 'PUT', credentials: 'include', redirect: 'error', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
      });
      if (!response.ok) { setMessage('Registry configuration was rejected. Check the registry host and your project permissions.'); return; }
      const text = await response.text(); if (text.length > 2048) throw new Error('Invalid acknowledgement');
      const acknowledgement = z.object({ data: z.object({ registry: z.object({ registryHost: z.string(), authenticationConfigured: z.boolean() }).strict() }).strict(), error: z.null() }).passthrough().parse(JSON.parse(text));
      if (acknowledgement.data.registry.registryHost !== registryHost || acknowledgement.data.registry.authenticationConfigured !== Boolean(username && password)) throw new Error('Mismatched acknowledgement');
      setMessage('Registry configuration saved.');
    } catch { setMessage('Registry configuration could not be saved.'); }
    finally { form.reset(); setPending(false); }
  }
  return <Card id="registry-configuration"><CardHeader><CardTitle>Docker registry</CardTitle><CardDescription>Save credentials for an approved registry used by this project. Leave username and password empty for public images.</CardDescription></CardHeader><CardContent>
    <form onSubmit={save} aria-describedby="registry-status"><FieldGroup>
      <Field><FieldLabel htmlFor="registry-host">Registry host</FieldLabel><Input id="registry-host" name="registryHost" placeholder="ghcr.io" required disabled={pending} autoComplete="off" /></Field>
      <Field><FieldLabel htmlFor="registry-username">Username</FieldLabel><Input id="registry-username" name="username" disabled={pending} autoComplete="off" /></Field>
      <Field><FieldLabel htmlFor="registry-password">Password or access token</FieldLabel><Input id="registry-password" name="password" type="password" disabled={pending} autoComplete="new-password" /></Field>
    </FieldGroup><Button className="mt-3" type="submit" disabled={pending}>{pending ? 'Saving...' : 'Save registry'}</Button>
    <p id="registry-status" role="status" aria-live="polite" className="mt-3 text-sm text-muted-foreground">{message || 'Credentials are encrypted and are never displayed after saving.'}</p></form>
  </CardContent></Card>;
}
