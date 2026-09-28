import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/api_client.dart';
import '../core/format.dart';
import '../core/widgets.dart';
import 'customer_session.dart';
import 'payment_service.dart';

class WalletScreen extends StatelessWidget {
  const WalletScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(title: const Text('Wallet'), bottom: const TabBar(tabs: [Tab(text: 'Packages'), Tab(text: 'Membership'), Tab(text: 'Shop')])),
        body: const TabBarView(children: [_Packages(), _Memberships(), StoreView()]),
      ),
    );
  }
}

class _Packages extends StatelessWidget {
  const _Packages();

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return AsyncView<List<Map<String, dynamic>>>(
      load: () async => ((await api.get('/portal/packages')) as List).cast<Map<String, dynamic>>(),
      builder: (context, items, _) {
        if (items.isEmpty) {
          return ListView(children: const [EmptyState(icon: Icons.confirmation_number_outlined, title: 'No packages yet', message: 'Session packages save you money on regular visits. See the Shop tab.')]);
        }
        return ListView.separated(
          padding: const EdgeInsets.all(16),
          itemCount: items.length,
          separatorBuilder: (_, _) => const SizedBox(height: 10),
          itemBuilder: (context, i) {
            final p = items[i];
            final total = (p['total'] as num).toInt();
            final remaining = (p['remaining'] as num).toInt();
            return Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Expanded(child: Text(p['name'] as String, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600))),
                    StatusChip(p['status'] as String),
                  ]),
                  const SizedBox(height: 10),
                  LinearProgressIndicator(value: total == 0 ? 0 : remaining / total, minHeight: 8, borderRadius: BorderRadius.circular(8)),
                  const SizedBox(height: 6),
                  Text('$remaining of $total sessions left · ${p['status'] == 'ACTIVE' ? '${p['daysLeft']} days to use' : 'expired ${dateLabel(parseDate(p['expiresAt']))}'}', style: TextStyle(color: Colors.grey.shade700)),
                  const Divider(height: 24),
                  ...(p['items'] as List).cast<Map<String, dynamic>>().map((it) => Padding(
                        padding: const EdgeInsets.only(bottom: 4),
                        child: Row(children: [Expanded(child: Text(it['service'] as String)), Text('${it['remaining']} / ${it['total']}', style: const TextStyle(fontWeight: FontWeight.w600))]),
                      )),
                ]),
              ),
            );
          },
        );
      },
    );
  }
}

class _Memberships extends StatelessWidget {
  const _Memberships();

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return AsyncView<List<Map<String, dynamic>>>(
      load: () async => ((await api.get('/portal/memberships')) as List).cast<Map<String, dynamic>>(),
      builder: (context, items, _) {
        if (items.isEmpty) {
          return ListView(children: const [EmptyState(icon: Icons.card_membership_outlined, title: 'Not a member yet', message: 'Members get discounts and included sessions. See the Shop tab.')]);
        }
        final scheme = Theme.of(context).colorScheme;
        return ListView.separated(
          padding: const EdgeInsets.all(16),
          itemCount: items.length,
          separatorBuilder: (_, _) => const SizedBox(height: 10),
          itemBuilder: (context, i) {
            final m = items[i];
            final active = m['status'] == 'ACTIVE';
            return Card(
              color: active ? scheme.primary : null,
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: DefaultTextStyle.merge(
                  style: TextStyle(color: active ? scheme.onPrimary : null),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Expanded(child: Text(m['plan'] as String, style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: active ? scheme.onPrimary : null))),
                      if (!active) StatusChip(m['status'] as String),
                    ]),
                    const SizedBox(height: 4),
                    Text(active ? 'Valid till ${dateLabel(parseDate(m['expiresAt']))} · ${m['daysLeft']} days left' : 'Ended ${dateLabel(parseDate(m['expiresAt']))}'),
                    const SizedBox(height: 12),
                    ...(m['benefits'] as List).cast<String>().map((b) => Padding(
                          padding: const EdgeInsets.only(bottom: 4),
                          child: Row(children: [Icon(Icons.check_circle, size: 16, color: active ? scheme.onPrimary : scheme.primary), const SizedBox(width: 8), Expanded(child: Text(b))]),
                        )),
                  ]),
                ),
              ),
            );
          },
        );
      },
    );
  }
}

/// Packages and membership plans the customer can buy and pay for online.
class StoreView extends StatelessWidget {
  const StoreView({super.key});

  Future<String?> _pickBranch(BuildContext context, ApiClient api) async {
    final branches = ((await api.get('/portal/branches')) as List).cast<Map<String, dynamic>>();
    if (branches.isEmpty) throw ApiException('NOT_FOUND', 'No centre is accepting online purchases right now.');
    if (branches.length == 1 || !context.mounted) return branches.first['id'] as String;
    return showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: ListView(shrinkWrap: true, children: [
          const ListTile(title: Text('Which centre will you visit?', style: TextStyle(fontWeight: FontWeight.w600))),
          ...branches.map((b) => ListTile(leading: const Icon(Icons.storefront_outlined), title: Text(b['name'] as String), subtitle: Text(b['city'] as String? ?? ''), onTap: () => Navigator.pop(ctx, b['id'] as String))),
        ]),
      ),
    );
  }

  Future<void> _buy(BuildContext context, String itemType, Map<String, dynamic> item, Future<void> Function() reload) async {
    final api = context.read<ApiClient>();
    final payments = context.read<PaymentService>();
    final session = context.read<CustomerSession>();
    final branchId = await _pickBranch(context, api);
    if (branchId == null || !context.mounted) return;
    final res = await api.post('/portal/purchase', {'itemType': itemType, 'itemId': item['id'], 'branchId': branchId}) as Map<String, dynamic>;
    if (!context.mounted) return;
    final paid = await payments.pay(context, res['order'] as Map<String, dynamic>, businessName: session.businessName);
    if (!context.mounted) return;
    showInfo(context, paid ? '${item['name']} is now in your wallet' : 'Invoice ${res['invoiceNumber']} is saved; you can pay it from Invoices.');
    await reload();
  }

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    final currency = context.watch<CustomerSession>().currency;
    return AsyncView<Map<String, dynamic>>(
      load: () async => await api.get('/portal/store') as Map<String, dynamic>,
      builder: (context, store, reload) {
        final packages = (store['packages'] as List).cast<Map<String, dynamic>>();
        final plans = (store['memberships'] as List).cast<Map<String, dynamic>>();
        return ListView(padding: const EdgeInsets.all(16), children: [
          if (packages.isNotEmpty) const SectionTitle('Session packages'),
          ...packages.map((p) => _StoreCard(
                title: p['name'] as String,
                price: money(p['price'] as num, currency: currency),
                caption: '${(p['items'] as List).map((i) => '${(i as Map)['quantity']} × ${i['service']}').join(', ')} · valid ${p['validityDays']} days',
                badge: (p['savings'] as num) > 0 ? 'Save ${money(p['savings'] as num, currency: currency)}' : null,
                onBuy: () => _buy(context, 'PACKAGE', p, reload),
              )),
          if (plans.isNotEmpty) const SectionTitle('Memberships'),
          ...plans.map((m) => _StoreCard(
                title: m['name'] as String,
                price: '${money(m['price'] as num, currency: currency)} / ${titleCase(m['billingInterval'] as String? ?? 'plan').toLowerCase()}',
                caption: (m['benefits'] as List).cast<String>().join(' · '),
                onBuy: () => _buy(context, 'MEMBERSHIP', m, reload),
              )),
          if (packages.isEmpty && plans.isEmpty) const EmptyState(icon: Icons.shopping_bag_outlined, title: 'Nothing on sale right now'),
        ]);
      },
    );
  }
}

class _StoreCard extends StatelessWidget {
  const _StoreCard({required this.title, required this.price, required this.caption, required this.onBuy, this.badge});
  final String title;
  final String price;
  final String caption;
  final String? badge;
  final Future<void> Function() onBuy;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text(title, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600))),
              if (badge != null)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(color: Colors.green.shade50, borderRadius: BorderRadius.circular(20)),
                  child: Text(badge!, style: TextStyle(color: Colors.green.shade800, fontSize: 12, fontWeight: FontWeight.w600)),
                ),
            ]),
            const SizedBox(height: 6),
            Text(caption, style: TextStyle(color: Colors.grey.shade700)),
            const SizedBox(height: 12),
            Row(children: [
              Text(price, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
              const Spacer(),
              BusyButton(label: 'Buy', icon: Icons.shopping_cart_checkout, onPressed: onBuy),
            ]),
          ]),
        ),
      ),
    );
  }
}
