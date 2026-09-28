import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../core/config.dart';
import '../core/widgets.dart';
import 'customer_session.dart';

enum _Step { phone, code, profile }

/// Phone + OTP sign-in; first-time numbers finish with a one-screen profile.
class CustomerLoginScreen extends StatefulWidget {
  const CustomerLoginScreen({super.key});

  @override
  State<CustomerLoginScreen> createState() => _CustomerLoginScreenState();
}

class _CustomerLoginScreenState extends State<CustomerLoginScreen> {
  _Step _step = _Step.phone;
  final _phone = TextEditingController();
  final _code = TextEditingController();
  final _name = TextEditingController();
  final _email = TextEditingController();
  String? _devCode;
  String? _signupToken;
  String? _error;

  CustomerSession get _session => context.read<CustomerSession>();

  Future<void> _send() async {
    final digits = _phone.text.replaceAll(RegExp(r'\D'), '');
    if (digits.length < 10) return setState(() => _error = 'Enter your 10 digit mobile number');
    setState(() => _error = null);
    final dev = await _session.sendOtp(_phone.text);
    if (!mounted) return;
    setState(() {
      _devCode = dev;
      _step = _Step.code;
      _code.clear();
    });
  }

  Future<void> _verify() async {
    if (_code.text.trim().length != 6) return setState(() => _error = 'Enter the 6 digit code');
    setState(() => _error = null);
    final result = await _session.verifyOtp(_phone.text, _code.text);
    if (!mounted || !result.needsProfile) return;
    setState(() {
      _signupToken = result.signupToken;
      _step = _Step.profile;
    });
  }

  Future<void> _register() async {
    if (_name.text.trim().length < 2) return setState(() => _error = 'Tell us your name');
    setState(() => _error = null);
    await _session.register(_signupToken!, name: _name.text, email: _email.text);
  }

  Future<void> _guard(Future<void> Function() action) async {
    try {
      await action();
    } catch (e) {
      if (mounted) showError(context, e);
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
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                CircleAvatar(radius: 32, backgroundColor: scheme.primaryContainer, child: Icon(Icons.spa, size: 32, color: scheme.primary)),
                const SizedBox(height: 16),
                Text(config.appName, textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
                const SizedBox(height: 4),
                Text(_subtitle, textAlign: TextAlign.center, style: TextStyle(color: Colors.grey.shade600)),
                const SizedBox(height: 28),
                ..._fields(),
                if (_error != null) ...[
                  const SizedBox(height: 8),
                  Text(_error!, style: TextStyle(color: Colors.red.shade700)),
                ],
                const SizedBox(height: 20),
                switch (_step) {
                  _Step.phone => BusyButton(label: 'Send code', onPressed: _send),
                  _Step.code => BusyButton(label: 'Verify', onPressed: _verify),
                  _Step.profile => BusyButton(label: 'Create account', onPressed: _register),
                },
                if (_step == _Step.code) ...[
                  const SizedBox(height: 8),
                  Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                    TextButton(onPressed: () => setState(() => _step = _Step.phone), child: const Text('Change number')),
                    TextButton(
                      onPressed: () async {
                        try {
                          await _send();
                          if (context.mounted) showInfo(context, 'A new code is on its way');
                        } catch (e) {
                          if (context.mounted) showError(context, e);
                        }
                      },
                      child: const Text('Resend code'),
                    ),
                  ]),
                ],
              ]),
            ),
          ),
        ),
      ),
    );
  }

  String get _subtitle => switch (_step) {
        _Step.phone => 'Sign in with your mobile number to book and manage visits',
        _Step.code => 'Enter the code sent to ${_phone.text.trim()}',
        _Step.profile => 'Welcome! Just a couple of details to finish',
      };

  List<Widget> _fields() => switch (_step) {
        _Step.phone => [
            TextField(
              controller: _phone,
              autofocus: true,
              keyboardType: TextInputType.phone,
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[\d+ ]'))],
              decoration: const InputDecoration(labelText: 'Mobile number', prefixIcon: Icon(Icons.phone_outlined), hintText: '98450 12345'),
              onSubmitted: (_) => _guard(_send),
            ),
          ],
        _Step.code => [
            TextField(
              controller: _code,
              autofocus: true,
              keyboardType: TextInputType.number,
              maxLength: 6,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 24, letterSpacing: 8),
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              decoration: const InputDecoration(labelText: 'Verification code', counterText: ''),
              onSubmitted: (_) => _guard(_verify),
            ),
            if (_devCode != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text('Test mode code: $_devCode', textAlign: TextAlign.center, style: TextStyle(color: Colors.grey.shade600, fontSize: 12)),
              ),
          ],
        _Step.profile => [
            TextField(controller: _name, autofocus: true, textCapitalization: TextCapitalization.words, decoration: const InputDecoration(labelText: 'Your name', prefixIcon: Icon(Icons.person_outline))),
            const SizedBox(height: 12),
            TextField(controller: _email, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'Email (optional)', prefixIcon: Icon(Icons.mail_outline))),
          ],
      };
}
