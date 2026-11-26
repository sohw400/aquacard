import { SESv2Client, SendEmailCommand, type SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validAuthMailMessage, type AuthMailMessage } from './auth-mail';

export interface AuthMailTransport { send(id: string, message: AuthMailMessage, signal: AbortSignal): Promise<void>; close?(): void }
export class AuthMailTransportError extends Error {
  constructor(readonly permanent: boolean) { super('Authentication email transport is unavailable.'); }
}
const address = (value: unknown): value is string => typeof value === 'string' && value.length <= 254
  && /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63}$/.test(value);
const validId = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function authMailText(message: AuthMailMessage): { subject: string; text: string } {
  if (!validAuthMailMessage(message)) throw new AuthMailTransportError(true);
  const verification = message.purpose === 'email-verification';
  const expires = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(message.expiresAt);
  return { subject: verification ? 'Aqua 이메일 주소 확인' : 'Aqua 비밀번호 재설정', text: [
    verification ? 'Aqua에 로그인한 뒤 이메일 확인 화면에 아래 코드를 입력해 주세요.' : 'Aqua의 비밀번호 재설정 화면에 아래 복구 코드를 입력해 주세요.',
    '', message.token, '', `유효 시간: ${expires} (한국 시간)`,
    '가장 최근에 요청한 코드만 사용할 수 있습니다. 코드를 다른 사람에게 전달하지 마세요.',
    verification ? '이메일 확인은 본인확인이나 금융 서비스 이용 승인을 대신하지 않습니다.' : '비밀번호를 변경하면 기존 로그인은 모두 종료됩니다.',
    '직접 요청하지 않았다면 이 메일을 무시해 주세요.',
  ].join('\n') };
}

/** Injection accepts SDK-shaped data but never receives credentials from this module. */
export function createSesAuthMailTransport(options: {
  region: string; from: string; configurationSet?: string;
  send?: (input: SendEmailCommandInput, signal: AbortSignal) => Promise<unknown>;
}): AuthMailTransport {
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(options.region) || !address(options.from)
    || (options.configurationSet !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(options.configurationSet))) {
    throw new Error('Configure a valid AWS region, verified sender address and optional SES configuration set.');
  }
  // Fix the AWS endpoint rather than honoring process-wide endpoint overrides.
  // SES has no idempotent send key. A lost response can result in duplicate mail.
  const client = options.send ? null : new SESv2Client({ region: options.region, maxAttempts: 1,
    endpoint: `https://email.${options.region}.amazonaws.com${options.region.startsWith('cn-') ? '.cn' : ''}` });
  return {
    async send(id, message, signal) {
      if (!validId(id) || !validAuthMailMessage(message) || !address(message.email)) throw new AuthMailTransportError(true);
      if (signal.aborted) throw new AuthMailTransportError(false);
      const body = authMailText(message);
      const input: SendEmailCommandInput = {
        FromEmailAddress: options.from, Destination: { ToAddresses: [message.email] },
        Content: { Simple: { Subject: { Charset: 'UTF-8', Data: body.subject }, Body: { Text: { Charset: 'UTF-8', Data: body.text } } } },
        EmailTags: [{ Name: 'aqua-message', Value: id }, { Name: 'aqua-purpose', Value: message.purpose }],
        ...(options.configurationSet ? { ConfigurationSetName: options.configurationSet } : {}),
      };
      try {
        if (options.send) await options.send(input, signal);
        else await client!.send(new SendEmailCommand(input), { abortSignal: signal });
      } catch (error) {
        const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
        throw new AuthMailTransportError(['MessageRejected', 'MessageRejectedException', 'MailFromDomainNotVerifiedException', 'BadRequestException'].includes(String(name)));
      }
    },
    close() { client?.destroy(); },
  };
}

export async function createFileAuthMailTransport(directory: string): Promise<AuthMailTransport> {
  if (process.env.NODE_ENV === 'production') throw new Error('The development mailbox is disabled in production.');
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('Configure a private development mailbox directory.');
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const information = await lstat(root);
  if (!information.isDirectory() || information.isSymbolicLink() || (information.mode & 0o077) !== 0) throw new Error('The development mailbox must be a private directory.');
  return {
    async send(id, message, signal) {
      if (process.env.NODE_ENV === 'production' || !validId(id) || !validAuthMailMessage(message)) throw new AuthMailTransportError(true);
      if (signal.aborted) throw new AuthMailTransportError(false);
      const file = resolve(root, `${id}.json`);
      const contents = JSON.stringify({ id, to: message.email, purpose: message.purpose, token: message.token, createdAt: message.createdAt, expiresAt: message.expiresAt });
      let handle;
      try {
        handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw new AuthMailTransportError(false);
        // A response loss may retry the same message. Never overwrite or follow a
        // conflicting entry and never disclose its contents in the error path.
        const existing = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await existing.stat();
          if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 || await existing.readFile('utf8') !== contents) {
            throw new AuthMailTransportError(true);
          }
        } finally { await existing.close(); }
      } finally { await handle?.close(); }
    },
  };
}
export async function authMailTransportFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Promise<AuthMailTransport> {
  const production = process.env.NODE_ENV === 'production' || environment.NODE_ENV === 'production';
  const transport = environment.AQUA_AUTH_MAIL_TRANSPORT;
  if (transport === 'file') {
    if (production) throw new Error('The development mailbox is disabled in production.');
    return createFileAuthMailTransport(environment.AQUA_MAIL_DIR ?? 'data/mail');
  }
  if (transport !== 'ses') throw new Error('Choose an explicit auth mail transport: ses or development file.');
  return createSesAuthMailTransport({ region: environment.AWS_REGION ?? '', from: environment.AQUA_AUTH_MAIL_FROM ?? '',
    ...(environment.AQUA_AUTH_MAIL_SES_CONFIGURATION_SET ? { configurationSet: environment.AQUA_AUTH_MAIL_SES_CONFIGURATION_SET } : {}) });
}
