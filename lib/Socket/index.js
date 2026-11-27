import { DEFAULT_CONNECTION_CONFIG } from "../Defaults/index.js";
import { makeCommunitiesSocket } from "./communities.js";
import {
  makeNewsletterStatusSender,
  makeNewsletterStatusReactionSender,
  makeNewsletterStatusRevokeSender,
  makeNewsletterStatusFetcher,
  makeNewsletterStatusUpdatesFetcher,
} from "../Utils/newsletter-status.js";
export { Dugong } from "./dugong.js";
const makeWASocket = (config) => {
  const newConfig = {
    ...DEFAULT_CONNECTION_CONFIG,
    ...config,
  };
  const sock = makeCommunitiesSocket(newConfig);
  // status saluran (dari @levvsync/baileys 0.0.5, LevviSync, MIT)
  sock.sendNewsletterStatus = makeNewsletterStatusSender(sock, newConfig);
  sock.sendNewsletterStatusReaction = makeNewsletterStatusReactionSender(sock);
  sock.revokeNewsletterStatus = makeNewsletterStatusRevokeSender(sock);
  sock.getNewsletterStatuses = makeNewsletterStatusFetcher(sock);
  sock.getNewsletterStatusUpdates = makeNewsletterStatusUpdatesFetcher(sock);
  return sock;
};
export default makeWASocket;
//# sourceMappingURL=index.js.map
