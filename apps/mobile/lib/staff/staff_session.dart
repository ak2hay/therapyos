import 'package:flutter/foundation.dart';

import '../core/api_client.dart';
import '../core/token_store.dart';

enum SessionState { loading, signedOut, signedIn }

class StaffBranch {
  const StaffBranch(this.id, this.name);
  final String id;
  final String name;
}

/// Signed-in staff member (therapist, receptionist or manager) and their permissions.
class StaffSession extends ChangeNotifier {
  StaffSession(this.api) {
    api.onSessionExpired = _expired;
  }

  final ApiClient api;
  SessionState state = SessionState.loading;
  Map<String, dynamic> user = const {};
  String? branchId;

  String get name => user['name'] as String? ?? '';
  String get businessName => user['tenantName'] as String? ?? '';
  String get currency => user['currency'] as String? ?? 'INR';
  String? get therapistId => user['therapistId'] as String?;
  bool get isTherapist => therapistId != null;
  List<String> get roles => ((user['roleNames'] ?? user['roles']) as List? ?? const []).cast<String>();
  List<StaffBranch> get branches => ((user['branches'] as List?) ?? const []).cast<Map<String, dynamic>>().map((b) => StaffBranch(b['id'] as String, b['name'] as String)).toList();
  bool can(String permission) => ((user['permissions'] as List?) ?? const []).contains(permission);

  Future<void> restore() async {
    if (await api.tokens.read() == null) return _set(SessionState.signedOut);
    try {
      await _loadProfile();
    } catch (_) {
      await api.tokens.clear();
      _set(SessionState.signedOut);
    }
  }

  /// Throws [ApiException] with code `TENANT_REQUIRED` (and `details.tenants`) when the login matches several businesses.
  Future<void> login(String identifier, String password, {String? tenantSlug}) async {
    final data = await api.postPublic('/auth/login', {'identifier': identifier.trim(), 'password': password, 'tenantSlug': ?tenantSlug}) as Map<String, dynamic>;
    await api.tokens.write(Tokens.fromJson(data['tokens'] as Map<String, dynamic>));
    await _loadProfile();
  }

  Future<void> _loadProfile() async {
    user = await api.get('/auth/me') as Map<String, dynamic>;
    final ids = branches.map((b) => b.id).toList();
    if (branchId == null || !ids.contains(branchId)) branchId = ids.isEmpty ? null : ids.first;
    _set(SessionState.signedIn);
  }

  void selectBranch(String id) {
    branchId = id;
    notifyListeners();
  }

  Future<void> logout() async {
    final t = await api.tokens.read();
    if (t != null) {
      try {
        await api.postPublic('/auth/logout', {'refreshToken': t.refreshToken});
      } catch (_) {}
    }
    await api.tokens.clear();
    user = const {};
    _set(SessionState.signedOut);
  }

  void _expired() {
    user = const {};
    _set(SessionState.signedOut);
  }

  void _set(SessionState s) {
    state = s;
    notifyListeners();
  }
}
