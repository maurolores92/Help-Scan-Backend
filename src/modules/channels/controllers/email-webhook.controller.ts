import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../auth/decorators/public.decorator';
import { ChannelsService } from '../services/channels.service';

/**
 * Webhook público de correo entrante por compañía.
 * Recibe payloads JSON de forwarders/proveedores (Cloudflare Email Workers, Resend, Postmark, Mailgun, n8n, Make)
 * validando el token secreto `webhookSecret` configurado en la empresa.
 */
@Controller('channels/email/webhook')
export class EmailWebhookController {
  constructor(private readonly channelsService: ChannelsService) {}

  @Public()
  @SkipThrottle()
  @Post(':companyId')
  @HttpCode(HttpStatus.OK)
  async receiveInboundEmail(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Query('token') queryToken: string | undefined,
    @Headers('x-webhook-secret') headerSecret: string | undefined,
    @Headers('x-webhook-token') headerToken: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: any,
  ) {
    const bearerToken = authorization?.replace(/^Bearer\s+/i, '').trim();
    const token =
      headerSecret || headerToken || queryToken || bearerToken || '';

    return this.channelsService.ingestEmailFromWebhook(companyId, token, body);
  }
}
