/**
 * @file src/lib/partner118_request_xml.ts
 * @description Lossless Partner 118 request envelopes via `with { type: "text" }` (GATE-LOADER-TS71).
 */

import soapEnvelopeTemplateXml from "../templates/partner118_soap_envelope.xml" with { type: "text" };

type XmlNode = Bun.XML.Node;

function envelopeTemplateRoot(): XmlNode {
  return Bun.XML.parse(String(soapEnvelopeTemplateXml), {
    compact: false,
  }) as XmlNode;
}

/**
 * Build a deterministic GetTallyDelta SOAP body without string-concatenation XML injection.
 */
export function buildPartner118RequestXml(
  betGroupIdNumeric: number,
  gsliveSessionId: string,
): string {
  const root = envelopeTemplateRoot();
  const bodyNode: Bun.XML.NodeInput = {
    name: "soap:Envelope",
    attributes: root.attributes,
    children: [
      { comment: ` betGroupId=${betGroupIdNumeric >>> 0} ` },
      {
        name: "soap:Body",
        children: [
          {
            name: "m:GetTallyDelta",
            attributes: { "xmlns:m": "https://partner118.example/gslive" },
            children: [
              { name: "m:SessionId", children: [gsliveSessionId] },
              {
                name: "m:BetGroupId",
                children: [String(betGroupIdNumeric >>> 0)],
              },
            ],
          },
        ],
      },
    ],
  };

  return `<?xml version="1.0" encoding="UTF-8"?>\n${Bun.XML.stringify(bodyNode)}`;
}
