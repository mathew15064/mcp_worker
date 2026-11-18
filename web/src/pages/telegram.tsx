import { useState } from 'react';
import { Send, ShieldCheck } from 'lucide-react';
import { useApp } from '@/app-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  ActionForm,
  Field,
  PageHeading,
  SecurityNote,
  Section,
  StatusBadge,
} from '@/components/common';
import type { TelegramSettings } from '@/types';

export function TelegramPanel({
  personal = false,
  config,
  asPage = false,
}: {
  personal?: boolean;
  config?: TelegramSettings;
  asPage?: boolean;
}) {
  const { state, submit, busy } = useApp();
  const current = config || state?.data.telegram;
  const [enabled, setEnabled] = useState(current?.enabled || false);
  const action = personal ? '/account/telegram' : '/admin/settings/telegram';
  const testAction = action + '/test';
  return (
    <div>
      {asPage && (
        <PageHeading
          title="My Telegram"
          description="Configure your private notification destination, independent of Admin."
        />
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        <Section
          title="Telegram configuration"
          description="Notifications and delivery settings for this identity."
        >
          <ActionForm action={action} submitLabel="Save configuration">
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
              <span>
                <strong>Enable Telegram</strong>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Allow delivery to this destination.
                </span>
              </span>
              <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable Telegram" />
            </label>
            <input type="hidden" name="enabled" value={enabled ? 'true' : 'false'} />
            <Field label="Chat ID">
              <Input
                name="chat_id"
                defaultValue={current?.chatId || ''}
                maxLength={128}
                placeholder="Destination Chat ID"
              />
            </Field>
            <Field
              label="Bot token"
              description={
                current?.hasToken
                  ? 'An encrypted token is already stored. Leave blank to keep it.'
                  : 'Token is encrypted and never displayed again after saving.'
              }
            >
              <Input
                type="password"
                name="bot_token"
                autoComplete="off"
                aria-label="Bot token"
                placeholder={
                  current?.hasToken ? 'Stored securely (unchanged)' : 'Enter Telegram bot token'
                }
              />
            </Field>
          </ActionForm>
        </Section>
        <Section title="Current status" description="No credentials are disclosed by this page.">
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">Notifications</span>
              <StatusBadge status={enabled ? 'enabled' : 'disabled'} />
            </div>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">Token storage</span>
              {current?.hasToken ? (
                <Badge variant="secondary">
                  <ShieldCheck className="me-1 size-3" />
                  Encrypted
                </Badge>
              ) : (
                <Badge variant="outline">Not configured</Badge>
              )}
            </div>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">Chat ID</span>
              <code className="text-xs">{current?.chatId || '—'}</code>
            </div>
            <Button
              variant="outline"
              disabled={busy || !current?.hasToken || !current?.chatId}
              onClick={() => void submit(testAction)}
            >
              <Send className="size-4" />
              Send test message
            </Button>
          </div>
          <div className="mt-5">
            <SecurityNote>
              {personal
                ? 'Your Telegram secrets are separate from Admin settings.'
                : 'Bot tokens are encrypted at rest. Editing the form never returns the stored secret.'}
            </SecurityNote>
          </div>
        </Section>
      </div>
    </div>
  );
}
