// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RegistryConfigurationCard } from './registry-configuration-card';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function enter() {
  render(<RegistryConfigurationCard projectId="project-1" apiBaseUrl="https://api.example.test" />);
  fireEvent.change(screen.getByLabelText('Registry host'), { target: { value: 'ghcr.io' } });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'fixture-user' } });
  fireEvent.change(screen.getByLabelText('Password or access token'), { target: { value: 'fixture-token' } });
}
it('clears credential fields before waiting for the request and forbids redirect/cache', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {})); vi.stubGlobal('fetch', fetchImpl); enter();
  fireEvent.click(screen.getByRole('button', { name: 'Save registry' }));
  expect((screen.getByLabelText('Password or access token') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('');
  expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ credentials: 'include', redirect: 'error', cache: 'no-store' });
  expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toEqual({ registryHost: 'ghcr.io', username: 'fixture-user', password: 'fixture-token' });
});
it('rejects a foreign or malformed success acknowledgement without reflecting response secrets', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: { registry: { registryHost: 'foreign.example.test', authenticationConfigured: true, password: 'raw-response-secret' } }, error: null }), { status: 200 }))); enter();
  fireEvent.click(screen.getByRole('button', { name: 'Save registry' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('could not be saved'));
  expect(document.body.textContent).not.toContain('raw-response-secret');
});
it('accepts a matching redacted acknowledgement', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: { registry: { registryHost: 'ghcr.io', authenticationConfigured: true } }, error: null }), { status: 200 }))); enter();
  fireEvent.click(screen.getByRole('button', { name: 'Save registry' }));
  await screen.findByText('Registry configuration saved.');
  expect((screen.getByLabelText('Password or access token') as HTMLInputElement).value).toBe('');
});
