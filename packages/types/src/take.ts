export interface Take {
  id: string;
  sessionId: string;
  /** 0부터 시작 */
  index: number;
  name: string;
  durationSec: number;
  commentCount: number;
}

export interface TakeComment {
  id: string;
  takeId: string;
  authorName: string;
  atSec: number;
  text: string;
}
