import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/api_client.dart';
import '../core/format.dart';
import '../core/widgets.dart';
import 'customer_app.dart';
import 'customer_session.dart';
import 'profile_screen.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    final session = context.watch<CustomerSession>();
    final tabs = CustomerHome.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(session.businessName)),
      body: AsyncView<Map<String, dynamic>>(
        load: () async => await api.get('/portal/home') as Map<String, dynamic>,
        builder: (context, h, reload) {
          final next = h['nextAppointment'] as Map<String, dynamic>?;
          final membership = h['membership'] as Map<String, dynamic>?;
          final due = (h['amountDue'] as num?) ?? 0;
          return ListView(padding: const EdgeInsets.all(16), children: [
            Text('Hi ${session.name.split(' ').first} 👋', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            Text(membership != null ? '${membership['plan']} member' : 'Good to see you', style: TextStyle(color: Colors.grey.shade600)),
            const SizedBox(height: 16),
            if (next != null)
              _NextVisit(appointment: next, onTap: () => tabs?.go(CustomerHomeState.visits))
            else
              Card(
                child: ListTile(
                  contentPadding: const EdgeInsets.all(16),
                  leading: const Icon(Icons.event_available_outlined, size: 32),
                  title: const Text('No upcoming visits', style: TextStyle(fontWeight: FontWeight.w600)),
                  subtitle: const Text('Treat yourself — book your next session in a few taps.'),
                  trailing: FilledButton(onPressed: () => tabs?.go(CustomerHomeState.book), child: const Text('Book')),
                ),
              ),
            const SizedBox(height: 12),
            Row(children: [
              Expanded(child: _Tap(onTap: () => tabs?.go(CustomerHomeState.wallet), child: StatTile(label: 'Sessions', value: '${h['sessionsLeft']}', icon: Icons.confirmation_number_outlined))),
              const SizedBox(width: 10),
              Expanded(child: _Tap(onTap: () => tabs?.go(CustomerHomeState.visits), child: StatTile(label: 'Upcoming', value: '${h['upcomingCount']}', icon: Icons.event_outlined))),
              const SizedBox(width: 10),
              Expanded(
                child: _Tap(
                  onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const OffersScreen())),
                  child: StatTile(label: 'Offers', value: '${h['offers']}', icon: Icons.local_offer_outlined),
                ),
              ),
            ]),
            if (due > 0) ...[
              const SizedBox(height: 12),
              Card(
                color: Colors.orange.shade50,
                child: ListTile(
                  leading: Icon(Icons.receipt_long, color: Colors.orange.shade800),
                  title: Text('${money(due, currency: session.currency)} due'),
                  subtitle: const Text('Pay your open invoices online'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () async {
                    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const InvoicesScreen()));
                    await reload();
                  },
                ),
              ),
            ],
            const SectionTitle('Quick actions'),
            GridView.count(
              crossAxisCount: 4,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              children: [
                _Action(icon: Icons.add_circle_outline, label: 'Book', onTap: () => tabs?.go(CustomerHomeState.book)),
                _Action(icon: Icons.place_outlined, label: 'Centres', onTap: () => tabs?.go(CustomerHomeState.book)),
                _Action(icon: Icons.shopping_bag_outlined, label: 'Packages', onTap: () => tabs?.go(CustomerHomeState.wallet)),
                _Action(icon: Icons.receipt_long_outlined, label: 'Invoices', onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const InvoicesScreen()))),
              ],
            ),
          ]);
        },
      ),
    );
  }
}

class _NextVisit extends StatelessWidget {
  const _NextVisit({required this.appointment, required this.onTap});
  final Map<String, dynamic> appointment;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final a = appointment;
    return Card(
      color: scheme.primary,
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: DefaultTextStyle(
            style: TextStyle(color: scheme.onPrimary),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('NEXT VISIT', style: TextStyle(color: scheme.onPrimary.withValues(alpha: 0.8), fontSize: 12, letterSpacing: 1)),
              const SizedBox(height: 8),
              Text((a['service'] as Map)['name'] as String, style: TextStyle(color: scheme.onPrimary, fontSize: 20, fontWeight: FontWeight.w700)),
              const SizedBox(height: 4),
              Text('${dayLabel(a['date'] as String)} · ${timeLabel(a['time'] as String)}'),
              Text([(a['branch'] as Map)['name'], (a['therapist'] as Map?)?['name']].whereType<String>().join(' · ')),
            ]),
          ),
        ),
      ),
    );
  }
}

class _Tap extends StatelessWidget {
  const _Tap({required this.onTap, required this.child});
  final VoidCallback onTap;
  final Widget child;

  @override
  Widget build(BuildContext context) => InkWell(borderRadius: BorderRadius.circular(14), onTap: onTap, child: child);
}

class _Action extends StatelessWidget {
  const _Action({required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: onTap,
      child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
        CircleAvatar(backgroundColor: scheme.primaryContainer, child: Icon(icon, color: scheme.primary)),
        const SizedBox(height: 6),
        Text(label, style: const TextStyle(fontSize: 12)),
      ]),
    );
  }
}
