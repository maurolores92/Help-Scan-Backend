import { Injectable, Logger } from '@nestjs/common';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

export interface TelegramBotInfo {
  ok: boolean;
  botId: number;
  botUsername: string;
  botDisplayName: string;
  message: string;
}

@Injectable()
export class TelegramBotClientService {
  private readonly logger = new Logger(TelegramBotClientService.name);

  async getMe(botToken: string): Promise<TelegramBotInfo> {
    const token = botToken.trim();
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/getMe`, {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
    });

    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok || !data?.result) {
      throw new Error(
        this.formatTelegramError(
          data?.description || `HTTP ${res.status}`,
        ),
      );
    }

    const bot = data.result;
    const botUsername = String(bot.username || '').trim();
    const botDisplayName = String(bot.first_name || botUsername || 'Telegram Bot').trim();

    return {
      ok: true,
      botId: Number(bot.id),
      botUsername,
      botDisplayName,
      message: `Conexión exitosa con @${botUsername} (${botDisplayName}).`,
    };
  }

  async getUpdates(
    botToken: string,
    offset: number,
    timeoutSec = 20,
    signal?: AbortSignal,
  ): Promise<any[]> {
    const token = botToken.trim();
    const params = new URLSearchParams({
      offset: String(offset),
      timeout: String(timeoutSec),
      allowed_updates: JSON.stringify(['message']),
    });

    const timeoutSignal = AbortSignal.timeout((timeoutSec + 10) * 1000);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    const res = await fetch(
      `${TELEGRAM_API_BASE}/bot${token}/getUpdates?${params.toString()}`,
      {
        method: 'GET',
        signal: combinedSignal,
      },
    );

    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      throw new Error(
        this.formatTelegramError(
          data?.description || `HTTP ${res.status}`,
        ),
      );
    }

    return Array.isArray(data.result) ? data.result : [];
  }

  async deleteWebhook(botToken: string): Promise<void> {
    const token = botToken.trim();
    const res = await fetch(
      `${TELEGRAM_API_BASE}/bot${token}/deleteWebhook?drop_pending_updates=false`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!res.ok) {
      const data: any = await res.json().catch(() => ({}));
      this.logger.warn(
        `deleteWebhook devolvió HTTP ${res.status}: ${data?.description || ''}`,
      );
    }
  }

  async downloadFileBuffer(
    botToken: string,
    fileId: string,
  ): Promise<{ buffer: Buffer; filePath: string }> {
    const token = botToken.trim();
    const metaRes = await fetch(
      `${TELEGRAM_API_BASE}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
      {
        method: 'GET',
        signal: AbortSignal.timeout(12000),
      },
    );

    const metaJson: any = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok || !metaJson?.ok || !metaJson?.result?.file_path) {
      throw new Error(
        this.formatTelegramError(
          metaJson?.description || `Error obteniendo archivo (${metaRes.status})`,
        ),
      );
    }

    const filePath = String(metaJson.result.file_path);
    const binRes = await fetch(
      `${TELEGRAM_API_BASE}/file/bot${token}/${filePath}`,
      {
        method: 'GET',
        signal: AbortSignal.timeout(30000),
      },
    );

    if (!binRes.ok) {
      throw new Error(`Error descargando archivo de Telegram (${binRes.status})`);
    }

    const arrBuf = await binRes.arrayBuffer();
    return {
      buffer: Buffer.from(arrBuf),
      filePath,
    };
  }

  async sendMessage(
    botToken: string,
    chatId: string | number,
    text: string,
  ): Promise<void> {
    const token = botToken.trim();
    const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000),
        parse_mode: 'Markdown',
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      // Fallback sin parse_mode por si el nombre del archivo trae caracteres Markdown sin escapar
      const fallbackRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text.replace(/\*/g, '').slice(0, 4000),
        }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => null);

      if (!fallbackRes?.ok) {
        this.logger.warn(
          `No se pudo enviar respuesta Telegram a chat ${chatId} (${res.status})`,
        );
      }
    }
  }

  private formatTelegramError(raw: string): string {
    if (/Unauthorized|Not Found/i.test(raw)) {
      return 'El Bot Token de Telegram es inválido o fue revocado en @BotFather.';
    }
    if (/Conflict: terminated by other getUpdates request/i.test(raw)) {
      return 'Otro proceso está escuchando este mismo Bot Token en Telegram (conflicto de polling).';
    }
    return `Telegram Bot API: ${raw}`;
  }
}
