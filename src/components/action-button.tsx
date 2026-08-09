'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, type ButtonProps } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import type { ActionResult } from '@/app/actions';

/**
 * Runs a server action with pending state and an inline result message.
 *
 * Actions return `{ ok, message }` instead of throwing, so a failed sync shows
 * a red line under the button rather than replacing the page with an error —
 * which matters when the page you'd lose is the live draft board.
 */
export function ActionButton({
  action,
  children,
  confirm,
  onDone,
  className,
  messageClassName,
  ...buttonProps
}: {
  action: () => Promise<ActionResult>;
  children: React.ReactNode;
  confirm?: string;
  onDone?: (result: ActionResult) => void;
  messageClassName?: string;
} & Omit<ButtonProps, 'onClick' | 'action'>) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<ActionResult | null>(null);

  async function run() {
    if (confirm && !window.confirm(confirm)) return;
    setPending(true);
    setResult(null);
    try {
      const res = await action();
      setResult(res);
      onDone?.(res);
      if (res.ok) router.refresh();
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setPending(false);
    }
  }

  return (
    <span className={cn('inline-flex flex-col gap-1', className)}>
      <Button {...buttonProps} disabled={pending || buttonProps.disabled} onClick={run}>
        {pending ? 'Working…' : children}
      </Button>
      {result ? (
        <span
          className={cn(
            'max-w-prose text-xs',
            result.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
            messageClassName,
          )}
        >
          {result.message}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Same idea for `<form action={...}>` submissions, which is the better fit for
 * anything with more than one field.
 */
export function ActionForm({
  action,
  children,
  className,
  submitLabel = 'Save',
  resetOnSuccess = false,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  children: React.ReactNode;
  className?: string;
  submitLabel?: string;
  resetOnSuccess?: boolean;
}) {
  const router = useRouter();
  const formRef = React.useRef<HTMLFormElement>(null);
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<ActionResult | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setPending(true);
    setResult(null);
    try {
      const res = await action(formData);
      setResult(res);
      if (res.ok) {
        if (resetOnSuccess) formRef.current?.reset();
        router.refresh();
      }
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setPending(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className={cn('space-y-3', className)}>
      {children}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Working…' : submitLabel}
        </Button>
        {result ? (
          <span
            className={cn(
              'text-xs',
              result.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
            )}
          >
            {result.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}
