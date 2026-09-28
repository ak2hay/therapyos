import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../core/api_client.dart';
import '../core/format.dart';
import '../core/widgets.dart';
import 'customer_session.dart';
import 'payment_service.dart';

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  Future<void> _update(BuildContext context, Map<String, Object?> changes) async {
    try {
      await context.read<CustomerSession>().update(changes);
    } catch (e) {
      if (context.mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<CustomerSession>();
    final me = session.me;
    final business = session.business;
    return Scaffold(
      appBar: AppBar(title: const Text('Profile')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Row(children: [
              CircleAvatar(radius: 28, child: Text(initials(session.name), style: const TextStyle(fontSize: 20))),
              const SizedBox(width: 16),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(session.name, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
                  Text(me['phone'] as String? ?? '', style: TextStyle(color: Colors.grey.shade600)),
                  if (me['email'] != null) Text(me['email'] as String, style: TextStyle(color: Colors.grey.shade600)),
                  const SizedBox(height: 4),
                  Text('Member since ${dateLabel(parseDate(me['memberSince']))} · ${me['visits'] ?? 0} visits', style: TextStyle(color: Colors.grey.shade600, fontSize: 12)),
                ]),
              ),
              IconButton(tooltip: 'Edit profile', icon: const Icon(Icons.edit_outlined), onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const EditProfileScreen()))),
            ]),
          ),
        ),
        const SectionTitle('Account'),
        Card(
          child: Column(children: [
            ListTile(leading: const Icon(Icons.receipt_long_outlined), title: const Text('Invoices & payments'), trailing: const Icon(Icons.chevron_right), onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const InvoicesScreen()))),
            ListTile(leading: const Icon(Icons.local_offer_outlined), title: const Text('Offers & coupons'), trailing: const Icon(Icons.chevron_right), onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const OffersScreen()))),
          ]),
        ),
        const SectionTitle('Messages'),
        Card(
          child: Column(children: [
            SwitchListTile(
              title: const Text('WhatsApp updates'),
              subtitle: const Text('Booking confirmations and reminders'),
              value: me['whatsappOptIn'] == true,
              onChanged: (v) => _update(context, {'whatsappOptIn': v}),
            ),
            SwitchListTile(
              title: const Text('Offers and news'),
              subtitle: const Text('Occasional promotions from us'),
              value: me['marketingOptIn'] == true,
              onChanged: (v) => _update(context, {'marketingOptIn': v}),
            ),
          ]),
        ),
        const SectionTitle('Help'),
        Card(
          child: Column(children: [
            ListTile(leading: const Icon(Icons.business_outlined), title: Text(session.businessName), subtitle: business['phone'] != null ? Text(business['phone'] as String) : null),
            ListTile(
              leading: Icon(Icons.logout, color: Colors.red.shade700),
              title: Text('Sign out', style: TextStyle(color: Colors.red.shade700)),
              onTap: () async {
                if (await confirm(context, title: 'Sign out?', message: 'You can sign in again any time with your mobile number.', action: 'Sign out')) await session.logout();
              },
            ),
          ]),
        ),
      ]),
    );
  }
}

class EditProfileScreen extends StatefulWidget {
  const EditProfileScreen({super.key});

  @override
  State<EditProfileScreen> createState() => _EditProfileScreenState();
}

class _EditProfileScreenState extends State<EditProfileScreen> {
  final _form = GlobalKey<FormState>();
  late final TextEditingController _name;
  late final TextEditingController _email;
  String? _gender;
  String? _dob;

  @override
  void initState() {
    super.initState();
    final me = context.read<CustomerSession>().me;
    _name = TextEditingController(text: me['name'] as String? ?? '');
    _email = TextEditingController(text: me['email'] as String? ?? '');
    _gender = me['gender'] as String?;
    _dob = me['dob'] as String?;
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    await context.read<CustomerSession>().update({
      'name': _name.text.trim(),
      'email': _email.text.trim().isEmpty ? null : _email.text.trim(),
      'gender': _gender,
      'dob': _dob,
    });
    if (!mounted) return;
    showInfo(context, 'Profile updated');
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Edit profile')),
      body: Form(
        key: _form,
        child: ListView(padding: const EdgeInsets.all(16), children: [
          TextFormField(controller: _name, decoration: const InputDecoration(labelText: 'Name'), validator: (v) => (v ?? '').trim().length < 2 ? 'Enter your name' : null),
          const SizedBox(height: 12),
          TextFormField(
            controller: _email,
            decoration: const InputDecoration(labelText: 'Email'),
            keyboardType: TextInputType.emailAddress,
            validator: (v) => (v ?? '').trim().isEmpty || RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(v!.trim()) ? null : 'Enter a valid email',
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<String?>(
            initialValue: _gender,
            decoration: const InputDecoration(labelText: 'Gender'),
            items: const [
              DropdownMenuItem(value: null, child: Text('Prefer not to say')),
              DropdownMenuItem(value: 'FEMALE', child: Text('Female')),
              DropdownMenuItem(value: 'MALE', child: Text('Male')),
              DropdownMenuItem(value: 'OTHER', child: Text('Other')),
            ],
            onChanged: (v) => setState(() => _gender = v),
          ),
          const SizedBox(height: 12),
          InkWell(
            onTap: () async {
              final now = DateTime.now();
              final picked = await showDatePicker(context: context, firstDate: DateTime(1920), lastDate: now, initialDate: DateTime.tryParse(_dob ?? '') ?? DateTime(now.year - 30));
              if (picked != null) setState(() => _dob = isoDate(picked));
            },
            child: InputDecorator(
              decoration: const InputDecoration(labelText: 'Birthday', helperText: 'We send a treat on your birthday'),
              child: Text(_dob == null ? 'Not set' : dateLabel(DateTime.parse(_dob!))),
            ),
          ),
          const SizedBox(height: 24),
          BusyButton(label: 'Save', icon: Icons.save_outlined, onPressed: _save),
        ]),
      ),
    );
  }
}

class InvoicesScreen extends StatelessWidget {
  const InvoicesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    final session = context.watch<CustomerSession>();
    return Scaffold(
      appBar: AppBar(title: const Text('Invoices')),
      body: AsyncView<List<Map<String, dynamic>>>(
        load: () async => ((await api.get('/portal/invoices')) as List).cast<Map<String, dynamic>>(),
        builder: (context, items, reload) {
          if (items.isEmpty) return ListView(children: const [EmptyState(icon: Icons.receipt_long_outlined, title: 'No invoices yet')]);
          return ListView.separated(
            padding: const EdgeInsets.all(16),
            itemCount: items.length,
            separatorBuilder: (_, _) => const SizedBox(height: 10),
            itemBuilder: (context, i) {
              final inv = items[i];
              final balance = (inv['balance'] as num?) ?? 0;
              final currency = inv['currency'] as String? ?? session.currency;
              return Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Expanded(child: Text(inv['invoiceNumber'] as String, style: const TextStyle(fontWeight: FontWeight.w600))),
                      StatusChip(inv['status'] as String),
                    ]),
                    const SizedBox(height: 4),
                    Text(inv['summary'] as String? ?? '', style: TextStyle(color: Colors.grey.shade700)),
                    Text('${inv['branch']} · ${dateLabel(parseDate(inv['issuedAt']))}', style: TextStyle(color: Colors.grey.shade600, fontSize: 12)),
                    const SizedBox(height: 10),
                    Row(children: [
                      Text(money(inv['total'] as num, currency: currency), style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                      if (balance > 0) Text('  ·  ${money(balance, currency: currency)} due', style: TextStyle(color: Colors.orange.shade800)),
                      const Spacer(),
                      if (balance > 0)
                        BusyButton(
                          label: 'Pay now',
                          onPressed: () async {
                            final order = await api.post('/portal/invoices/${inv['id']}/pay') as Map<String, dynamic>;
                            if (!context.mounted) return;
                            final paid = await context.read<PaymentService>().pay(context, order, businessName: session.businessName);
                            if (paid && context.mounted) showInfo(context, 'Payment received. Thank you!');
                            await reload();
                          },
                        ),
                    ]),
                  ]),
                ),
              );
            },
          );
        },
      ),
    );
  }
}

class OffersScreen extends StatelessWidget {
  const OffersScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    final currency = context.watch<CustomerSession>().currency;
    return Scaffold(
      appBar: AppBar(title: const Text('Offers')),
      body: AsyncView<Map<String, dynamic>>(
        load: () async => await api.get('/portal/offers') as Map<String, dynamic>,
        builder: (context, data, _) {
          final offers = (data['offers'] as List).cast<Map<String, dynamic>>();
          final coupons = (data['coupons'] as List).cast<Map<String, dynamic>>();
          if (offers.isEmpty && coupons.isEmpty) return ListView(children: const [EmptyState(icon: Icons.local_offer_outlined, title: 'No offers right now', message: 'Check back soon.')]);
          return ListView(padding: const EdgeInsets.all(16), children: [
            if (coupons.isNotEmpty) const SectionTitle('Coupons'),
            ...coupons.map((c) {
              final pct = c['discountType'] == 'PERCENTAGE';
              final value = pct ? '${(c['discountValue'] as num).toStringAsFixed(0)}% off' : '${money(c['discountValue'] as num, currency: currency)} off';
              return Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Card(
                  child: ListTile(
                    contentPadding: const EdgeInsets.all(16),
                    title: Text(value, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 18)),
                    subtitle: Text([
                      c['description'],
                      if (c['minimumOrder'] != null) 'Min. order ${money(c['minimumOrder'] as num, currency: currency)}',
                      'Valid till ${dateLabel(DateTime.tryParse(c['endDate'] as String))}',
                    ].whereType<String>().join('\n')),
                    trailing: OutlinedButton.icon(
                      icon: const Icon(Icons.copy, size: 16),
                      label: Text(c['code'] as String),
                      onPressed: () async {
                        await Clipboard.setData(ClipboardData(text: c['code'] as String));
                        if (context.mounted) showInfo(context, 'Code ${c['code']} copied — show it at the counter');
                      },
                    ),
                  ),
                ),
              );
            }),
            if (offers.isNotEmpty) const SectionTitle('Running offers'),
            ...offers.map((o) => Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Card(
                    child: ListTile(
                      contentPadding: const EdgeInsets.all(16),
                      leading: const Icon(Icons.celebration_outlined),
                      title: Text(o['name'] as String, style: const TextStyle(fontWeight: FontWeight.w600)),
                      subtitle: Text([o['description'], if (o['autoApply'] == true) 'Applied automatically at billing', 'Ends ${dateLabel(DateTime.tryParse(o['endDate'] as String))}'].whereType<String>().join('\n')),
                    ),
                  ),
                )),
          ]);
        },
      ),
    );
  }
}
