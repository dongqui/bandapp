/** Contact us 주제 칩 (디자인 ctTopics 순서). 클라이언트가 각 언어로 번역한다 */
export const SUPPORT_TOPICS = ["billing", "broken", "idea", "other"] as const;
export type SupportTopic = (typeof SUPPORT_TOPICS)[number];

export const SUPPORT_BODY_MAX = 2000;

export interface CreateSupportRequestInput {
  topic: SupportTopic;
  /** trim 후 1~SUPPORT_BODY_MAX자 */
  body: string;
  /** 디자인: "Your app version and device model are attached" */
  appVersion?: string;
  device?: string;
}

export interface SupportRequestCreated {
  id: string;
}
