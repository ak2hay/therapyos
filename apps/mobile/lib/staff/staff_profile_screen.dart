import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/config.dart';
import '../core/format.dart';
import '../core/widgets.dart';
import 'staff_session.dart';

class StaffProfileScreen extends StatelessWidget {
  const StaffProfileScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final staff = context.watch<StaffSession>();
    final config = context.read<AppConfig>();
    final u = staff.user;
    return Scaffold(
      appBar: AppBar(title: const Text('Profile')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Row(children: [
              CircleAvatar(radius: 28, child: Text(initials(staff.name), style: const TextStyle(fontSize: 20))),
              const SizedBox(width: 16),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(staff.name, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
                  if (u['email'] != null) Text(u['email'] as String, style: TextStyle(color: Colors.grey.shade600)),
                  const SizedBox(height: 6),
                  Wrap(spacing: 6, runSpacing: 6, children: staff.roles.map((r) => StatusChip(r)).toList()),
                ]),
              ),
            ]),
          ),
        ),
        const SectionTitle('Workplace'),
        Card(
          child: Column(children: [
            ListTile(leading: const Icon(Icons.business_outlined), title: const Text('Business'), subtitle: Text(staff.businessName)),
            ListTile(
              leading: const Icon(Icons.storefront_outlined),
              title: const Text('Branches'),
              subtitle: Text(staff.branches.isEmpty ? 'None' : staff.branches.map((b) => b.name).join(', ')),
            ),
          ]),
        ),
        const SectionTitle('App'),
        Card(
          child: Column(children: [
            ListTile(leading: const Icon(Icons.dns_outlined), title: const Text('Server'), subtitle: Text(config.apiUrl)),
            ListTile(
              leading: Icon(Icons.logout, color: Colors.red.shade700),
              title: Text('Sign out', style: TextStyle(color: Colors.red.shade700)),
              onTap: () async {
                if (await confirm(context, title: 'Sign out?', message: 'You will need your password to sign in again.', action: 'Sign out')) {
                  await staff.logout();
                }
              },
            ),
          ]),
        ),
      ]),
    );
  }
}
