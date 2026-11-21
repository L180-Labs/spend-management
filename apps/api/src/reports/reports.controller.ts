import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ReportsService, DashboardSpendPeriod, SPEND_TREND_GRANULARITIES, SpendTrendGranularity } from './reports.service';

const VALID_PERIODS: DashboardSpendPeriod[] = ['this_month', 'last_month', 'this_quarter', 'year_to_date'];

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private reports: ReportsService) {}

  @Get('dashboard-kpis')
  dashboardKpis(@Req() req: any) {
    return this.reports.dashboardKpis(req.user.orgId);
  }

  @Get('period-spend')
  periodSpend(@Req() req: any, @Query('period') period?: string) {
    const p = VALID_PERIODS.includes(period as DashboardSpendPeriod) ? (period as DashboardSpendPeriod) : 'this_month';
    return this.reports.periodSpend(req.user.orgId, p);
  }

  @Get('period-spend-by-tool')
  periodSpendByTool(@Req() req: any, @Query('period') period?: string) {
    const p = VALID_PERIODS.includes(period as DashboardSpendPeriod) ? (period as DashboardSpendPeriod) : 'this_month';
    return this.reports.periodSpendByTool(req.user.orgId, p);
  }

  @Get('spend-trend')
  spendTrend(@Req() req: any, @Query('granularity') granularity?: string, @Query('buckets') buckets?: string) {
    const g = SPEND_TREND_GRANULARITIES.includes(granularity as SpendTrendGranularity) ? (granularity as SpendTrendGranularity) : 'month';
    const n = buckets ? parseInt(buckets, 10) : undefined;
    return this.reports.spendTrend(req.user.orgId, g, Number.isFinite(n) ? n : undefined);
  }

  @Get('spend-by-category')
  spendByCategory(@Req() req: any, @Query('monthKey') monthKey?: string) {
    return this.reports.spendByCategory(req.user.orgId, monthKey);
  }

  @Get('spend-by-department')
  spendByDepartment(@Req() req: any, @Query('monthKey') monthKey?: string) {
    return this.reports.spendByDepartment(req.user.orgId, monthKey);
  }

  @Get('billing-history')
  billingHistory(@Req() req: any, @Query() q: any) {
    return this.reports.billingHistory(req.user.orgId, {
      monthKey: q.monthKey,
      toolId: q.toolId,
      status: q.status,
      page: q.page ? parseInt(q.page) : 1,
      limit: q.limit ? parseInt(q.limit) : 20,
    });
  }

  @Get('approval-sla')
  approvalSla(@Req() req: any) {
    return this.reports.approvalSla(req.user.orgId);
  }

  @Get('forecasted-spend')
  forecastedSpend(@Req() req: any, @Query('months') months?: string) {
    return this.reports.forecastedSpend(req.user.orgId, months ? parseInt(months) : 3);
  }
}
