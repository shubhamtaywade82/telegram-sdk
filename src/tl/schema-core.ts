// GENERATED FILE - DO NOT EDIT.
// Source: src/tl/core.tl (core MTProto service schema)
// Regenerate with: node scripts/codegen.mjs
import type { TLDescriptor } from './index.js';

export const LAYER = 232;

export const ALL_CORE_CONSTRUCTORS: readonly TLDescriptor[] = [
  { id: 0x5162463, kind: 'constructor', name: 'resPQ', type: 'ResPQ', args: [{ name: 'nonce', type: 'int128' }, { name: 'server_nonce', type: 'int128' }, { name: 'pq', type: 'bytes' }, { name: 'server_public_key_fingerprints', type: 'Vector<long>' }] },
  { id: 0x83c95aec, kind: 'constructor', name: 'p_q_inner_data', type: 'P_Q_inner_data', args: [{ name: 'pq', type: 'bytes' }, { name: 'p', type: 'bytes' }, { name: 'q', type: 'bytes' }, { name: 'nonce', type: 'int128' }, { name: 'server_nonce', type: 'int128' }, { name: 'new_nonce', type: 'int256' }] },
  { id: 0xa9f55f95, kind: 'constructor', name: 'p_q_inner_data_dc', type: 'P_Q_inner_data', args: [{ name: 'pq', type: 'bytes' }, { name: 'p', type: 'bytes' }, { name: 'q', type: 'bytes' }, { name: 'nonce', type: 'int128' }, { name: 'server_nonce', type: 'int128' }, { name: 'new_nonce', type: 'int256' }, { name: 'dc', type: 'int' }] },
  { id: 0x3c6a84d4, kind: 'constructor', name: 'p_q_inner_data_temp', type: 'P_Q_inner_data', args: [{ name: 'pq', type: 'bytes' }, { name: 'p', type: 'bytes' }, { name: 'q', type: 'bytes' }, { name: 'nonce', type: 'int128' }, { name: 'server_nonce', type: 'int128' }, { name: 'new_nonce', type: 'int256' }, { name: 'expires_in', type: 'int' }] },
  { id: 0x56fddf88, kind: 'constructor', name: 'p_q_inner_data_temp_dc', type: 'P_Q_inner_data', args: [{ name: 'pq', type: 'bytes' }, { name: 'p', type: 'bytes' }, { name: 'q', type: 'bytes' }, { name: 'nonce', type: 'int128' }, { name: 'server_nonce', type: 'int128' }, { name: 'new_nonce', type: 'int256' }, { name: 'dc', type: 'int' }, { name: 'expires_in', type: 'int' }] },
  { id: 0x75a3f765, kind: 'constructor', name: 'bind_auth_key_inner', type: 'BindAuthKeyInner', args: [{ name: 'nonce', type: 'long' }, { name: 'temp_auth_key_id', type: 'long' }, { name: 'perm_auth_key_id', type: 'long' }, { name: 'temp_session_id', type: 'long' }, { name: 'expires_at', type: 'int' }] },
  { id: 0x79cb045d, kind: 'constructor', name: 'server_DH_params_fail', type: 'Server_DH_Params', args: [{ name: 'nonce', type: 'int128' }, { name: 'server_nonce', type: 'int128' }, { name: 'new_nonce_hash', type: 'int128' }] },
  { id: 0xd0e8075c, kind: 'constructor', name: 'server_DH_params_ok', type: 'Server_DH_Params', args: [{ name: 'nonce', type: 'int128' }, { name: 'server_nonce', type: 'int128' }, { name: 'encrypted_answer', type: 'bytes' }] },
  { id: 0xb5890dba, kind: 'constructor', name: 'server_DH_inner_data', type: 'Server_DH_inner_data', args: [{ name: 'nonce', type: 'int128' }, { name: 'server_nonce', type: 'int128' }, { name: 'g', type: 'int' }, { name: 'dh_prime', type: 'bytes' }, { name: 'g_a', type: 'bytes' }, { name: 'server_time', type: 'int' }] },
  { id: 0x6643b654, kind: 'constructor', name: 'client_DH_inner_data', type: 'Client_DH_Inner_Data', args: [{ name: 'nonce', type: 'int128' }, { name: 'server_nonce', type: 'int128' }, { name: 'retry_id', type: 'long' }, { name: 'g_b', type: 'bytes' }] },
  { id: 0x3bcbf734, kind: 'constructor', name: 'dh_gen_ok', type: 'Set_client_DH_params_answer', args: [{ name: 'nonce', type: 'int128' }, { name: 'server_nonce', type: 'int128' }, { name: 'new_nonce_hash1', type: 'int128' }] },
  { id: 0x46dc1fb9, kind: 'constructor', name: 'dh_gen_retry', type: 'Set_client_DH_params_answer', args: [{ name: 'nonce', type: 'int128' }, { name: 'server_nonce', type: 'int128' }, { name: 'new_nonce_hash2', type: 'int128' }] },
  { id: 0xa69dae02, kind: 'constructor', name: 'dh_gen_fail', type: 'Set_client_DH_params_answer', args: [{ name: 'nonce', type: 'int128' }, { name: 'server_nonce', type: 'int128' }, { name: 'new_nonce_hash3', type: 'int128' }] },
  { id: 0xf660e1d4, kind: 'constructor', name: 'destroy_auth_key_ok', type: 'DestroyAuthKeyRes', args: [] },
  { id: 0xa9f2259, kind: 'constructor', name: 'destroy_auth_key_none', type: 'DestroyAuthKeyRes', args: [] },
  { id: 0xea109b13, kind: 'constructor', name: 'destroy_auth_key_fail', type: 'DestroyAuthKeyRes', args: [] },
  { id: 0x62d6b459, kind: 'constructor', name: 'msgs_ack', type: 'MsgsAck', args: [{ name: 'msg_ids', type: 'Vector<long>' }] },
  { id: 0xa7eff811, kind: 'constructor', name: 'bad_msg_notification', type: 'BadMsgNotification', args: [{ name: 'bad_msg_id', type: 'long' }, { name: 'bad_msg_seqno', type: 'int' }, { name: 'error_code', type: 'int' }] },
  { id: 0xedab447b, kind: 'constructor', name: 'bad_server_salt', type: 'BadMsgNotification', args: [{ name: 'bad_msg_id', type: 'long' }, { name: 'bad_msg_seqno', type: 'int' }, { name: 'error_code', type: 'int' }, { name: 'new_server_salt', type: 'long' }] },
  { id: 0xda69fb52, kind: 'constructor', name: 'msgs_state_req', type: 'MsgsStateReq', args: [{ name: 'msg_ids', type: 'Vector<long>' }] },
  { id: 0x4deb57d, kind: 'constructor', name: 'msgs_state_info', type: 'MsgsStateInfo', args: [{ name: 'req_msg_id', type: 'long' }, { name: 'info', type: 'string' }] },
  { id: 0x8cc0d131, kind: 'constructor', name: 'msgs_all_info', type: 'MsgsAllInfo', args: [{ name: 'msg_ids', type: 'Vector<long>' }, { name: 'info', type: 'string' }] },
  { id: 0x276d3ec6, kind: 'constructor', name: 'msg_detailed_info', type: 'MsgDetailedInfo', args: [{ name: 'msg_id', type: 'long' }, { name: 'answer_msg_id', type: 'long' }, { name: 'bytes', type: 'int' }, { name: 'status', type: 'int' }] },
  { id: 0x809db6df, kind: 'constructor', name: 'msg_new_detailed_info', type: 'MsgDetailedInfo', args: [{ name: 'answer_msg_id', type: 'long' }, { name: 'bytes', type: 'int' }, { name: 'status', type: 'int' }] },
  { id: 0x7d861a08, kind: 'constructor', name: 'msg_resend_req', type: 'MsgResendReq', args: [{ name: 'msg_ids', type: 'Vector<long>' }] },
  { id: 0x2144ca19, kind: 'constructor', name: 'rpc_error', type: 'RpcError', args: [{ name: 'error_code', type: 'int' }, { name: 'error_message', type: 'string' }] },
  { id: 0x5e2ad36e, kind: 'constructor', name: 'rpc_answer_unknown', type: 'RpcDropAnswer', args: [] },
  { id: 0xcd78e586, kind: 'constructor', name: 'rpc_answer_dropped_running', type: 'RpcDropAnswer', args: [] },
  { id: 0xa43ad8b7, kind: 'constructor', name: 'rpc_answer_dropped', type: 'RpcDropAnswer', args: [{ name: 'msg_id', type: 'long' }, { name: 'seq_no', type: 'int' }, { name: 'bytes', type: 'int' }] },
  { id: 0x949d9dc, kind: 'constructor', name: 'future_salt', type: 'FutureSalt', args: [{ name: 'valid_since', type: 'int' }, { name: 'valid_until', type: 'int' }, { name: 'salt', type: 'long' }] },
  { id: 0xae500895, kind: 'constructor', name: 'future_salts', type: 'FutureSalts', args: [{ name: 'req_msg_id', type: 'long' }, { name: 'now', type: 'int' }, { name: 'salts', type: 'vector<future_salt>' }] },
  { id: 0x347773c5, kind: 'constructor', name: 'pong', type: 'Pong', args: [{ name: 'msg_id', type: 'long' }, { name: 'ping_id', type: 'long' }] },
  { id: 0xe22045fc, kind: 'constructor', name: 'destroy_session_ok', type: 'DestroySessionRes', args: [{ name: 'session_id', type: 'long' }] },
  { id: 0x62d350c9, kind: 'constructor', name: 'destroy_session_none', type: 'DestroySessionRes', args: [{ name: 'session_id', type: 'long' }] },
  { id: 0x9ec20908, kind: 'constructor', name: 'new_session_created', type: 'NewSession', args: [{ name: 'first_msg_id', type: 'long' }, { name: 'unique_id', type: 'long' }, { name: 'server_salt', type: 'long' }] },
  { id: 0x9299359f, kind: 'constructor', name: 'http_wait', type: 'HttpWait', args: [{ name: 'max_delay', type: 'int' }, { name: 'wait_after', type: 'int' }, { name: 'max_wait', type: 'int' }] },
  { id: 0xd433ad73, kind: 'constructor', name: 'ipPort', type: 'IpPort', args: [{ name: 'ipv4', type: 'int' }, { name: 'port', type: 'int' }] },
  { id: 0x37982646, kind: 'constructor', name: 'ipPortSecret', type: 'IpPort', args: [{ name: 'ipv4', type: 'int' }, { name: 'port', type: 'int' }, { name: 'secret', type: 'bytes' }] },
  { id: 0x4679b65f, kind: 'constructor', name: 'accessPointRule', type: 'AccessPointRule', args: [{ name: 'phone_prefix_rules', type: 'string' }, { name: 'dc_id', type: 'int' }, { name: 'ips', type: 'vector<IpPort>' }] },
  { id: 0x5a592a6c, kind: 'constructor', name: 'help.configSimple', type: 'help.ConfigSimple', args: [{ name: 'date', type: 'int' }, { name: 'expires', type: 'int' }, { name: 'rules', type: 'vector<AccessPointRule>' }] },
];

export const ALL_CORE_METHODS: readonly TLDescriptor[] = [
  { id: 0x60469778, kind: 'method', name: 'req_pq', type: 'ResPQ', args: [{ name: 'nonce', type: 'int128' }] },
  { id: 0xbe7e8ef1, kind: 'method', name: 'req_pq_multi', type: 'ResPQ', args: [{ name: 'nonce', type: 'int128' }] },
  { id: 0xd712e4be, kind: 'method', name: 'req_DH_params', type: 'Server_DH_Params', args: [{ name: 'nonce', type: 'int128' }, { name: 'server_nonce', type: 'int128' }, { name: 'p', type: 'bytes' }, { name: 'q', type: 'bytes' }, { name: 'public_key_fingerprint', type: 'long' }, { name: 'encrypted_data', type: 'bytes' }] },
  { id: 0xf5045f1f, kind: 'method', name: 'set_client_DH_params', type: 'Set_client_DH_params_answer', args: [{ name: 'nonce', type: 'int128' }, { name: 'server_nonce', type: 'int128' }, { name: 'encrypted_data', type: 'bytes' }] },
  { id: 0xd1435160, kind: 'method', name: 'destroy_auth_key', type: 'DestroyAuthKeyRes', args: [] },
  { id: 0x58e4a740, kind: 'method', name: 'rpc_drop_answer', type: 'RpcDropAnswer', args: [{ name: 'req_msg_id', type: 'long' }] },
  { id: 0xb921bd04, kind: 'method', name: 'get_future_salts', type: 'FutureSalts', args: [{ name: 'num', type: 'int' }] },
  { id: 0x7abe77ec, kind: 'method', name: 'ping', type: 'Pong', args: [{ name: 'ping_id', type: 'long' }] },
  { id: 0xf3427b8c, kind: 'method', name: 'ping_delay_disconnect', type: 'Pong', args: [{ name: 'ping_id', type: 'long' }, { name: 'disconnect_delay', type: 'int' }] },
  { id: 0xe7512126, kind: 'method', name: 'destroy_session', type: 'DestroySessionRes', args: [{ name: 'session_id', type: 'long' }] },
];
