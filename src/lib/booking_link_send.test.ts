import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sendBookingLinkSmsForRoute, type CaraAgentUserData } from './cara_tools.js';
import type { RoutingLink } from './routing_links.js';

function mockUserData(links: RoutingLink[]): CaraAgentUserData {
  return {
    organizationId: 'org-test',
    businessName: 'Test Salon',
    calledNumber: '+353749389378',
    callerPhone: '+353872715938',
    routingLinks: links,
    businessFiles: [],
    fallbackNumber: null,
    callRoutingMode: null,
    disclosureConfirmed: true,
    sessionFlags: {
      linkSent: false,
      actionTicketCreated: false,
      callbackRequested: false,
      smsSent: 0,
      endPhoneCallUsed: false,
      askedAnythingElse: false,
      awaitingAnythingElseReply: false,
      anythingElseAskCount: 0,
      callerRespondedAfterAnythingElse: false,
      bookingRouteId: null,
      bookingLinkSendInFlight: false,
      closingCall: false,
      likelySttGarble: false,
    },
  };
}

describe('sendBookingLinkSmsForRoute', () => {
  it('dry-runs SMS without regex consent flags', async () => {
    const prev = process.env.CARA_SMS_DRY_RUN;
    process.env.CARA_SMS_DRY_RUN = 'true';
    try {
      const links: RoutingLink[] = [
        {
          id: 'book-1',
          label: 'Book online',
          intent: 'book appointment',
          targetType: 'link',
          url: 'https://fresha.com/book',
          linkDelivery: 'sms',
          active: true,
        },
      ];
      const ud = mockUserData(links);
      const result = await sendBookingLinkSmsForRoute(ud, 'book-1');
      assert.equal(result.ok, true);
      assert.equal(ud.sessionFlags.linkSent, true);
    } finally {
      if (prev === undefined) delete process.env.CARA_SMS_DRY_RUN;
      else process.env.CARA_SMS_DRY_RUN = prev;
    }
  });
});
