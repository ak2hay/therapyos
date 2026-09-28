import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/api_client.dart';
import '../core/config.dart';
import '../core/widgets.dart';
import 'staff_session.dart';

class StaffLoginScreen extends StatefulWidget {
  const StaffLoginScreen({super.key});

  @override
  State<StaffLoginScreen> createState() => _StaffLoginScreenState();
}

class _StaffLoginScreenState extends State<StaffLoginScreen> {
  final _identifier = TextEditingController();
  final _password = TextEditingController();
  final _form = GlobalKey<FormState>();
  List<Map<String, dynamic>> _tenants = const [];
  String? _tenant;
  bool _busy = false;
  bool _obscure = true;

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    setState(() => _busy = true);
    try {
      await context.read<StaffSession>().login(_identifier.text, _password.text, tenantSlug: _tenant);
    } on ApiException catch (e) {
      if (e.code == 'TENANT_REQUIRED') {
        setState(() => _tenants = ((e.details?['tenants'] as List?) ?? const []).cast<Map<String, dynamic>>());
        if (mounted) showInfo(context, e.message);
      } else if (mounted) {
        showError(context, e);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final config = context.read<AppConfig>();
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _form,
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  CircleAvatar(radius: 30, backgroundColor: scheme.primary, child: const Icon(Icons.spa_outlined, color: Colors.white, size: 30)),
                  const SizedBox(height: 16),
                  Text(config.appName, textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 4),
                  Text('Sign in to see your sessions and the queue', textAlign: TextAlign.center, style: TextStyle(color: Colors.grey.shade600)),
                  const SizedBox(height: 28),
                  TextFormField(
                    controller: _identifier,
                    keyboardType: TextInputType.emailAddress,
                    autofillHints: const [AutofillHints.username],
                    decoration: const InputDecoration(labelText: 'Email or phone', prefixIcon: Icon(Icons.person_outline)),
                    validator: (v) => (v ?? '').trim().length < 3 ? 'Enter your email or phone' : null,
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: _password,
                    obscureText: _obscure,
                    autofillHints: const [AutofillHints.password],
                    decoration: InputDecoration(
                      labelText: 'Password',
                      prefixIcon: const Icon(Icons.lock_outline),
                      suffixIcon: IconButton(icon: Icon(_obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined), onPressed: () => setState(() => _obscure = !_obscure)),
                    ),
                    validator: (v) => (v ?? '').isEmpty ? 'Enter your password' : null,
                    onFieldSubmitted: (_) => _submit(),
                  ),
                  if (_tenants.isNotEmpty) ...[
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      initialValue: _tenant,
                      decoration: const InputDecoration(labelText: 'Business', prefixIcon: Icon(Icons.storefront_outlined)),
                      items: _tenants.map((t) => DropdownMenuItem(value: t['slug'] as String, child: Text(t['name'] as String))).toList(),
                      onChanged: (v) => setState(() => _tenant = v),
                      validator: (v) => v == null ? 'Choose a business' : null,
                    ),
                  ],
                  const SizedBox(height: 20),
                  FilledButton(
                    onPressed: _busy ? null : _submit,
                    child: _busy ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : const Text('Sign in'),
                  ),
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
