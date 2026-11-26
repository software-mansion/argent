import { TypedEventEmitter, type ServiceBlueprint, type ServiceEvents } from "@argent/registry";
import {
  createRemoteAudioSession,
  releaseRemoteAudio,
  type RemoteAudioSession,
} from "../utils/ios-audio-remote";

// Session for the `audio-*` tools on one Argent Cloud simulator: the link to the feeder running in it. Disposing it
// disconnects the feeder, which gives the apps their microphone back and exits.
export const IOS_REMOTE_AUDIO_SESSION_NAMESPACE = "IosRemoteAudioSession";

export const iosRemoteAudioSessionBlueprint: ServiceBlueprint<RemoteAudioSession, string> = {
  namespace: IOS_REMOTE_AUDIO_SESSION_NAMESPACE,

  getURN(udid: string) {
    return `${IOS_REMOTE_AUDIO_SESSION_NAMESPACE}:${udid}`;
  },

  async factory(_deps, udid) {
    const session = createRemoteAudioSession(udid);
    return {
      api: session,
      dispose: () => releaseRemoteAudio(session),
      events: new TypedEventEmitter<ServiceEvents>(),
    };
  },
};
