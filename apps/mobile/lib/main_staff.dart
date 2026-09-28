import 'package:flutter/material.dart';

import 'core/api_client.dart';
import 'core/config.dart';
import 'core/token_store.dart';
import 'staff/staff_app.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final config = AppConfig.fromEnvironment(AppFlavor.staff);
  final api = ApiClient(baseUrl: config.apiBase, tokens: SecureTokenStore('staff'), refreshPath: '/auth/refresh');
  runApp(StaffApp(config: config, api: api));
}
