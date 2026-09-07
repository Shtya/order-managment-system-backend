import { CampaignAudienceType } from "entities/campaigns.entity";

export type NormalizedAudienceRecipient = {
  phoneNumber: string;
  name?: string | null;
  clientId?: string | null;
  customerId?: string | null;
};

export type ManualRecipientInput = {
  phoneNumber: string;
  name?: string;
};

export type ManualSnapshotEntry = {
  phoneNumber: string;
  name?: string | null;
};

// Everything a provider may need to validate its input. Staged file
// uploads ride with create/update (atomic); stored urls cover the rest.
export type AudienceInput = {
  audienceSegmentId?: string | null;
  audienceFilter?: any;
  manualRecipients?: ManualRecipientInput[] | null;
  stagedFilePath?: string | null;
  fileUrl?: string | null;
};

// Resolved source for count/listPage. Manual entries are the normalized
// snapshot; file resolves to a staged path (create) or stored url.
export type AudienceSource =
  | { kind: "manual"; entries: ManualSnapshotEntry[] }
  | { kind: "file"; filePath?: string; fileUrl?: string | null }
  | { kind: "filter"; filter: any }
  | { kind: "segment"; segmentId: string };

export type AudiencePage = {
  records: NormalizedAudienceRecipient[];
  hasMore: boolean;
  nextCursor?: any;
};

// Mirrors ShippingProvider / SmsProvider / CampaignChannel: one provider
// per audience type behind a map in CampaignsService. New types (e.g. a
// saved list, an external CRM) plug in without touching the service.
export abstract class CampaignAudience {
  abstract readonly type: CampaignAudienceType;

  // Shape + ownership validation. Throws BadRequestException.
  abstract validate(adminId: string, input: AudienceInput): Promise<void>;

  // Estimate without storing. Counts raw candidates (before exclusions
  // and no-phone skips) unless the provider can do better.
  abstract count(adminId: string, source: AudienceSource): Promise<number>;

  // Paginated normalized rows for materialize. limit defaults per provider.
  abstract listPage(
    adminId: string,
    source: AudienceSource,
    cursor?: any,
    limit?: number,
  ): Promise<AudiencePage>;
}
