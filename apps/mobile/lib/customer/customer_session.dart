import 'package:flutter/material.dart';

import '../core/api_client.dart';
import '../core/config.dart';
import '../core/theme.dart';
import '../core/token_store.dart';

enum CustomerState { loading, signedOut, signedIn }

/// Result of verifying an OTP: either signed in, or a new number that must complete a short profile.
class OtpResult {
  const OtpResult.signedIn() : signupToken = null;
  const OtpResult.needsProfile(String this.signupToken);
  final String? signupToken;
  bool get needsProfile => signupToken != null;
}

class CustomerSession extends ChangeNotifier {
  CustomerSession(this.api, this.config) {
    api.onSessionExpired = _expired;
  }

  final ApiClient api;
  final AppConfig config;
  CustomerState state = CustomerState.loading;
  Map<String, dynamic> me = const {};

  Map<String, dynamic> get business => (me['business'] as Map<String, dynamic>?) ?? const {};
  String get name => me['name'] as String? ?? '';
  String get currency => business['currency'] as String? ?? 'INR';
  String get businessName => business['name'] as String? ?? config.appName;
  Color get brandColor => parseHex(business['primaryColor'] as String?) ?? brandTeal;

  Future<void> restore() async {
    if (await api.tokens.read() == null) return _set(CustomerState.signedOut);
    try {
      await reload();
    } catch (_) {
      await api.tokens.clear();
      _set(CustomerState.signedOut);
    }
  }

  Future<void> reload() async {
    me = await api.get('/portal/me') as Map<String, dynamic>;
    _set(CustomerState.signedIn);
  }

  /// Returns the development code when the API runs outside production (shown as a hint on the OTP screen).
  Future<String?> sendOtp(String phone) async {
    final res = await api.postPublic('/portal/auth/send-otp', {'tenantSlug': config.tenantSlug, 'phone': phone.trim()}) as Map<String, dynamic>;
    return res['devCode'] as String?;
  }

  Future<OtpResult> verifyOtp(String phone, String code) async {
    final res = await api.postPublic('/portal/auth/verify-otp', {'tenantSlug': config.tenantSlug, 'phone': phone.trim(), 'code': code.trim()}) as Map<String, dynamic>;
    if (res['needsProfile'] == true) return OtpResult.needsProfile(res['signupToken'] as String);
    await _signIn(res);
    return const OtpResult.signedIn();
  }

  Future<void> register(String signupToken, {required String name, String? email}) async {
    final res = await api.postPublic('/portal/auth/register', {
      'signupToken': signupToken,
      'name': name.trim(),
      if (email != null && email.trim().isNotEmpty) 'email': email.trim(),
    }) as Map<String, dynamic>;
    await _signIn(res);
  }

  Future<void> _signIn(Map<String, dynamic> res) async {
    await api.tokens.write(Tokens.fromJson(res['tokens'] as Map<String, dynamic>));
    await reload();
  }

  Future<void> update(Map<String, Object?> changes) async {
    me = await api.patch('/portal/me', changes) as Map<String, dynamic>;
    notifyListeners();
  }

  Future<void> logout() async {
    final t = await api.tokens.read();
    if (t != null) {
      try {
        await api.postPublic('/portal/auth/logout', {'refreshToken': t.refreshToken});
      } catch (_) {}
    }
    await api.tokens.clear();
    me = const {};
    _set(CustomerState.signedOut);
  }

  void _expired() {
    me = const {};
    _set(CustomerState.signedOut);
  }

  void _set(CustomerState s) {
    state = s;
    notifyListeners();
  }
}
