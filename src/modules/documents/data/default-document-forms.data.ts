import { DefaultDocumentFormSeed } from './forms/form-shared.constants';
import { FACTURA_FORM_SEED } from './forms/factura.form';
import { NOTA_CREDITO_FORM_SEED } from './forms/nota-credito.form';
import { NOTA_DEBITO_FORM_SEED } from './forms/nota-debito.form';
import { PRESUPUESTO_FORM_SEED } from './forms/presupuesto.form';
import { REMITO_FORM_SEED } from './forms/remito.form';
import { ORDEN_COMPRA_FORM_SEED } from './forms/orden-compra.form';
import { NOTA_PEDIDO_FORM_SEED } from './forms/nota-pedido.form';
import { RECIBO_FORM_SEED } from './forms/recibo.form';
import { ORDEN_PAGO_FORM_SEED } from './forms/orden-pago.form';
import { CERTIFICADO_RETENCION_FORM_SEED } from './forms/certificado-retencion.form';
import { TICKET_FISCAL_FORM_SEED } from './forms/ticket-fiscal.form';
import { TRANSFERENCIA_PAGO_FORM_SEED } from './forms/transferencia-pago.form';
import { ORDEN_SERVICIO_FORM_SEED } from './forms/orden-servicio.form';
import { CONTRATO_FORM_SEED } from './forms/contrato.form';
import { LEGAJO_FORM_SEED } from './forms/legajo.form';
import { DOCUMENTO_GENERAL_FORM_SEED } from './forms/documento-general.form';

export type { DefaultDocumentFormSeed };

export const DEFAULT_DOCUMENT_FORMS_SEED: DefaultDocumentFormSeed[] = [
  FACTURA_FORM_SEED,
  NOTA_CREDITO_FORM_SEED,
  NOTA_DEBITO_FORM_SEED,
  PRESUPUESTO_FORM_SEED,
  REMITO_FORM_SEED,
  ORDEN_COMPRA_FORM_SEED,
  NOTA_PEDIDO_FORM_SEED,
  RECIBO_FORM_SEED,
  ORDEN_PAGO_FORM_SEED,
  CERTIFICADO_RETENCION_FORM_SEED,
  TICKET_FISCAL_FORM_SEED,
  TRANSFERENCIA_PAGO_FORM_SEED,
  ORDEN_SERVICIO_FORM_SEED,
  CONTRATO_FORM_SEED,
  LEGAJO_FORM_SEED,
  DOCUMENTO_GENERAL_FORM_SEED,
].map((form, index) => ({
  ...form,
  displayOrder: index + 1,
}));
